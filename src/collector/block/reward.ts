import * as Bluebird from 'bluebird'
import { getRepository, EntityManager } from 'typeorm'
import { get, mergeWith } from 'lodash'

import config from 'config'
import { TxEntity, RewardEntity, BlockEntity } from 'orm'

import * as lcd from 'lib/lcd'
import { collectorLogger as logger } from 'lib/logger'
import { plus, minus } from 'lib/math'
import { splitDenomAndAmount } from 'lib/common'
import { getDateRangeOfLastMinute, getQueryDateTime, getStartOfPreviousMinuteTs } from 'lib/time'

import { getUSDValue, queryAllActivePrices, addDatetimeFilterToQuery } from './helper'

function extractGasFee(tx: TxEntity): DenomMap {
  return tx.data.tx.value.fee.amount.reduce((acc, item) => {
    acc[item.denom] = plus(acc[item.denom], item.amount)
    return acc
  }, {} as DenomMap)
}

function extractTax(tx: TxEntity): DenomMap {
  return tx.data.logs.reduce((acc, item) => {
    const taxes = typeof item.log === 'object' ? item.log.tax : null

    if (taxes) {
      taxes.split(',').forEach((tax) => {
        const { amount, denom } = splitDenomAndAmount(tax)
        acc[denom] = plus(acc[denom], amount)
      })
    }

    return acc
  }, {} as DenomMap)
}

function extractSwapFee(tx: TxEntity): DenomMap {
  return tx.data.logs.reduce((acc, item) => {
    item.events &&
      item.events.forEach((event) => {
        if (event.type === 'swap') {
          const swapFeeAttribute = event.attributes.find((attr) => attr.key === 'swap_fee')

          if (swapFeeAttribute) {
            const { amount, denom } = splitDenomAndAmount(swapFeeAttribute.value)
            acc[denom] = plus(acc[denom], amount)

            logger.debug(`SWAPFEE! ${tx.hash} ${denom} ${acc[denom]}`)
          }
        }
      })
    return acc
  }, {} as DenomMap)
}

async function queryFees(timestamp: number): Promise<{
  gas: DenomMap
  tax: DenomMap
  swapfee: DenomMap
}> {
  const qb = getRepository(TxEntity).createQueryBuilder('tx').select(`tx.data`)
  addDatetimeFilterToQuery(timestamp, qb)

  // .leftJoinAndSelect("tx.block", "block")
  // .where("tx.block_id is not null");

  const txs = await qb.getMany()
  const rewardMerger = (obj, src) => mergeWith(obj, src, (o, s) => plus(o, s))

  return txs
    .filter((tx) => !tx.data.code)
    .reduce(
      (acc, tx) => {
        const gas = extractGasFee(tx)
        const tax = extractTax(tx)
        const swapfee = extractSwapFee(tx)
        return mergeWith(acc, { gas, tax, swapfee }, rewardMerger)
      },
      { gas: {}, tax: {}, swapfee: {} }
    )
}

interface Rewards {
  reward: DenomMap
  commission: DenomMap
}

export async function getRewards(timestamp: number): Promise<Rewards> {
  const result: Rewards = { reward: {}, commission: {} }
  const { from, to } = getDateRangeOfLastMinute(timestamp)
  const qb = getRepository(BlockEntity)
    .createQueryBuilder('block')
    .leftJoinAndSelect('block.reward', 'reward')
    .andWhere(`block.timestamp >= '${getQueryDateTime(from)}'`)
    .andWhere(`block.timestamp < '${getQueryDateTime(to)}'`)

  const blocks: BlockEntity[] = await qb.getMany()

  if (!blocks.length) {
    return result
  }

  const lastBlock = await getRepository(BlockEntity).findOne({
    chainId: config.CHAIN_ID,
    height: blocks[blocks.length - 1].height + 1
  })

  if (lastBlock) {
    blocks.push(lastBlock)
  }

  blocks.shift()

  const rewardMerger = (obj, src) => mergeWith(obj, src, (o, s) => plus(o, s))

  return blocks.reduce((acc, block) => {
    const reward = block.reward.reward
    const commission = block.reward.commission
    return mergeWith(acc, { reward, commission }, rewardMerger)
  }, result)
}

export async function collectReward(mgr: EntityManager, timestamp: number, strHeight: string) {
  const { reward: rewardSum, commission } = await getRewards(timestamp)
  const datetime = new Date(getStartOfPreviousMinuteTs(timestamp))
  const [issuances, rewards, activePrices] = await Promise.all([
    lcd.getAllActiveIssuance(strHeight),
    queryFees(timestamp),
    queryAllActivePrices(datetime.getTime())
  ])

  await Bluebird.map(Object.keys(issuances), async (denom) => {
    // early exit for denoms without reward
    if (!rewardSum[denom]) {
      return
    }

    const reward = new RewardEntity()
    reward.denom = denom
    reward.datetime = datetime
    reward.tax = get(rewards, `tax.${denom}`, '0')
    reward.taxUsd = getUSDValue(denom, reward.tax, activePrices)
    reward.gas = get(rewards, `gas.${denom}`, '0')
    reward.gasUsd = getUSDValue(denom, reward.gas, activePrices)
    reward.sum = rewardSum[denom]
    reward.commission = commission[denom]

    const oracle = minus(minus(reward.sum, reward.tax), reward.gas)
    reward.oracle = Number(oracle) < 0 ? '0' : oracle
    reward.oracleUsd = getUSDValue(denom, reward.oracle, activePrices)

    const existing = await mgr.findOne(RewardEntity, { denom, datetime })

    if (existing) {
      mgr.update(RewardEntity, existing.id, reward)
    } else {
      mgr.insert(RewardEntity, reward)
    }
  })

  logger.info(`collectReward: ${datetime}`)
}

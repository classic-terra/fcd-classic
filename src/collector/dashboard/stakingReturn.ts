import { EntityManager } from 'typeorm'
import { subDays } from 'date-fns'

import * as lcd from 'lib/lcd'
import { times, div, plus, getIntegerPortion } from 'lib/math'
import { getDateFromDateTime } from 'lib/time'

import { GeneralInfoEntity } from 'orm'

import { convertDbTimestampToDate, getPriceObjKey } from './helpers'
import { getRewardsSumByDateDenom } from './rewardsInfo'
import { getPriceHistory } from 'service/dashboard'
import { BOND_DENOM } from 'lib/constant'

interface DailyReturnInfo {
  tax: string
  gas: string
  oracle: string
  commission: string
  reward: string
}

interface DailyStakingInfo {
  reward: string // bigint
  avgStaking: string // bigint
}

async function getAvgBondedTokensByDate(
  mgr: EntityManager,
  to: Date,
  daysBefore?: number
): Promise<{
  [date: string]: string
}> {
  const issuance = (await lcd.getTotalSupply()).find((e) => e.denom === BOND_DENOM)?.amount || '0'
  const stakingQb = mgr
    .getRepository(GeneralInfoEntity)
    .createQueryBuilder()
    .select(convertDbTimestampToDate('datetime'), 'date')
    .addSelect('AVG(staking_ratio)', 'avg_staking_ratio')
    .addSelect('AVG(bonded_tokens)', 'avg_bonded_tokens')
    .groupBy('date')
    .orderBy('date', 'DESC')
    .where('datetime < :to', { to })

  if (daysBefore) {
    stakingQb.andWhere('datetime >= :from', { from: subDays(to, daysBefore) })
  }

  const bondedTokens = await stakingQb.getRawMany()

  const bondedTokensObj = bondedTokens.reduce((acc, item) => {
    acc[item.date] = getIntegerPortion(item.avg_bonded_tokens ?? times(issuance, item.avg_staking_ratio))
    return acc
  }, {})
  return bondedTokensObj
}

async function getRewardsInLunaByDate(
  mgr: EntityManager,
  to: Date,
  daysBefore?: number
): Promise<{
  [date: string]: DailyReturnInfo
}> {
  const rewards = await getRewardsSumByDateDenom(mgr, to, daysBefore)
  const priceObj = await getPriceHistory(mgr, to, daysBefore)

  const rewardObj: {
    [date: string]: DailyReturnInfo
  } = rewards.reduce((acc, item) => {
    const key = getPriceObjKey(item.date, item.denom)

    if (!priceObj[key] && item.denom !== BOND_DENOM) {
      return acc
    }

    const tax = item.denom === BOND_DENOM ? item.tax_sum : div(item.tax_sum, priceObj[key])
    const gas = item.denom === BOND_DENOM ? item.gas_sum : div(item.gas_sum, priceObj[key])
    const oracle = item.denom === BOND_DENOM ? item.oracle_sum : div(item.oracle_sum, priceObj[key])
    const commission = item.denom === BOND_DENOM ? item.commission_sum : div(item.commission_sum, priceObj[key])
    const reward = item.denom === BOND_DENOM ? item.reward_sum : div(item.reward_sum, priceObj[key])

    const prev = acc[item.date] || {}

    acc[item.date] = {
      tax: getIntegerPortion(plus(prev.tax, tax)),
      gas: getIntegerPortion(plus(prev.gas, gas)),
      oracle: getIntegerPortion(plus(prev.oracle, oracle)),
      commission: getIntegerPortion(plus(prev.commission, commission)),
      reward: getIntegerPortion(plus(prev.reward, reward))
    }

    return acc
  }, {})
  return rewardObj
}

export async function getStakingReturnByDay(
  mgr: EntityManager,
  to: Date,
  daysBefore?: number
): Promise<{ [date: string]: DailyStakingInfo }> {
  const avgStakingObj = await getAvgBondedTokensByDate(mgr, to, daysBefore)
  const rewardObj = await getRewardsInLunaByDate(mgr, to, daysBefore)

  const stakingReturns = Object.keys(rewardObj).reduce((acc, date) => {
    const avgStaking = avgStakingObj[date]
    const reward = rewardObj[date].reward

    // TODO: Need to add a failsafe for not found staked
    acc[getDateFromDateTime(new Date(date))] = {
      reward,
      avgStaking
    }
    return acc
  }, {})
  return stakingReturns
}

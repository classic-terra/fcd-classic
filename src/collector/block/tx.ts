import * as Bluebird from 'bluebird'
import { EntityManager, In } from 'typeorm'
import { compact, chunk, keyBy, groupBy, flattenDeep, mapValues } from 'lodash'

import { BlockEntity, TxEntity, AccountTxEntity } from 'orm'

import * as lcd from 'lib/lcd'
import { collectorLogger as logger } from 'lib/logger'
import { times, minus, plus, min, getIntegerPortion } from 'lib/math'
import config from 'config'
import { generateAccountTxs } from './accountTx'
import { BOND_DENOM, BURN_TAX_UPGRADE_HEIGHT } from 'lib/constant'

class TaxPolicy {
  exemptionList: string[]
  public rate: string
  public caps: {
    [denom: string]: string
  }
  public policyCap: string

  public async fetch(height: string) {
    const [rate, lcdTaxCaps, treasuryParams, exemptionList] = await Promise.all([
      lcd.getTaxRate(height),
      lcd.getTaxCaps(height),
      lcd.getTreasuryParams(height),
      lcd.getTaxExemptionList(height)
    ])

    this.rate = rate
    ;(this.caps = mapValues(keyBy(lcdTaxCaps, 'denom'), 'tax_cap')),
      (this.policyCap = treasuryParams.tax_policy.cap.amount),
      (this.exemptionList = exemptionList)
  }

  public isExemption(from: string, to: string): boolean {
    if (!from || !to) {
      throw new Error('address nil')
    }

    return this.exemptionList.indexOf(from) !== -1 && this.exemptionList.indexOf(to) !== -1
  }
}

function getTaxCoins(lcdTx: Transaction.LcdTransaction, msg: Transaction.AminoMesssage, taxPolicy: TaxPolicy): Coin[] {
  let coins: Coin[] = []

  switch (msg.type) {
    case 'bank/MsgSend': {
      if (taxPolicy.isExemption(msg.value.from_address, msg.value.to_address)) {
        break
      }
      coins = msg.value.amount
      break
    }
    case 'bank/MsgMultiSend': {
      const taxInputs = msg.value.inputs.filter((input, idx) => {
        const output = msg.value.outputs[idx]
        return !taxPolicy.isExemption(input.address, output.address)
      })
      coins = flattenDeep(taxInputs.map((input) => input.coins))
      break
    }
    case 'market/MsgSwapSend': {
      coins = [msg.value.offer_coin]
      break
    }
    case 'wasm/MsgInstantiateContract': {
      coins = msg.value.init_coins || msg.value.funds
      break
    }
    case 'wasm/MsgInstantiateContract2': {
      coins = msg.value.funds
      break
    }
    case 'wasm/MsgExecuteContract': {
      coins = msg.value.coins || msg.value.funds
      break
    }
    case 'msgauth/MsgExecAuthorized':
    case 'authz/MsgExec': {
      coins = flattenDeep(msg.value.msgs.map(getTaxCoins))
      break
    }
  }

  if (!Array.isArray(coins)) {
    throw new Error(`cannot find tax field in msg: ${msg.type}, height: ${lcdTx.height}, txhash: ${lcdTx.txhash}`)
  }

  return coins
}

export function getTax(
  lcdTx: Transaction.LcdTransaction,
  msg: Transaction.AminoMesssage,
  taxPolicy: TaxPolicy
): Coin[] {
  const taxCoins = getTaxCoins(lcdTx, msg, taxPolicy)
  const groupByDenom = groupBy(taxCoins, 'denom')
  const coins = Object.keys(groupByDenom).map((denom) =>
    groupByDenom[denom].reduce((sum, coin) => ({ denom: sum.denom, amount: plus(sum.amount, coin.amount) }), {
      denom,
      amount: '0'
    })
  )

  return compact(
    coins.map((coin) => {
      // Columbus-5 no tax for Luna until burn tax upgrade
      if (coin.denom === BOND_DENOM && config.CHAIN_ID === 'columbus-5' && +lcdTx.height < BURN_TAX_UPGRADE_HEIGHT) {
        return
      }

      const cap = taxPolicy.caps[coin.denom] || taxPolicy.policyCap
      const tax = {
        denom: coin.denom,
        amount: min(getIntegerPortion(times(coin.amount, taxPolicy.rate)), cap)
      }
      return tax
    })
  )
}

function assignGasAndTax(lcdTx: Transaction.LcdTransaction, taxPolicy: TaxPolicy) {
  // early exit
  if (lcdTx.code || !lcdTx.logs?.length) {
    return
  }

  const fees = lcdTx.tx.value.fee.amount
  const feeObj = fees.reduce((acc, fee) => {
    acc[fee.denom] = fee.amount
    return acc
  }, {})

  const msgs = lcdTx.tx.value.msg
  const taxArr: string[][] = []

  // gas = fee - tax
  const gasObj = msgs.reduce((acc, msg) => {
    const msgTaxes = getTax(lcdTx, msg, taxPolicy)
    const taxPerMsg: string[] = []
    for (let i = 0; i < msgTaxes.length; i = i + 1) {
      const denom = msgTaxes[i].denom
      const amount = msgTaxes[i].amount

      if (feeObj[denom]) {
        feeObj[denom] = minus(feeObj[denom], amount)
      }

      if (feeObj[denom] === '0') {
        delete feeObj[denom]
      }

      taxPerMsg.push(`${amount}${denom}`)
    }
    taxArr.push(taxPerMsg)
    return acc
  }, feeObj)

  // replace fee to gas
  lcdTx.tx.value.fee.amount = Object.keys(gasObj).map((denom) => {
    return {
      denom,
      amount: gasObj[denom]
    }
  })

  if (lcdTx.logs.length !== taxArr.length) {
    throw new Error('logs and tax array length must be equal')
  }

  lcdTx.logs.forEach((log, i) => {
    if (taxArr[i].length) {
      log.log = {
        tax: taxArr[i].join(',')
      }
    }
  })
}

//Recursively iterating thru the keys of the tx object to find unicode characters that would otherwise mess up db update.
//If unicode is found in the string, then the value is base64 encoded.
//Recursion is not implemented well in js, so in case of deeply nested objects, this might fail with RangeError: Maximum call stack size exceeded
//Tx objects are hopefully not that deep, but just in case they are https://replit.com/@mkotsollaris/javascript-iterate-for-loop?v=1#index.js or something along those lines.
//Going with simple recursion due time constaints.
function sanitizeTx(tx: Transaction.LcdTransaction): Transaction.LcdTransaction {
  function hasUnicode(s) {
    // eslint-disable-next-line no-control-regex
    return /[^\u0000-\u007f]/.test(s)
  }

  const iterateTx = (obj) => {
    Object.keys(obj).forEach((key) => {
      if (typeof obj[key] === 'object' && obj[key] !== null) {
        iterateTx(obj[key])
      } else {
        if (hasUnicode(obj[key])) {
          const b = Buffer.from(obj[key])
          obj[key] = b.toString('base64')
        }
      }
    })
  }
  iterateTx(tx)
  return tx
}

async function generateTxEntities(txHashes: string[], block: BlockEntity): Promise<TxEntity[]> {
  const taxPolicy = new TaxPolicy()
  await taxPolicy.fetch(block.height.toString())

  // txs with the same tx hash may appear more than once in the same block duration
  const txHashesUnique = new Set(txHashes)

  return compact(
    await Bluebird.map([...txHashesUnique], async (txhash) => {
      const lcdTx = await lcd.getTx(txhash).catch(() => null)
      if (!lcdTx) return
      assignGasAndTax(lcdTx, taxPolicy)

      const txEntity = new TxEntity()
      txEntity.chainId = block.chainId
      txEntity.hash = lcdTx.txhash.toLowerCase()
      txEntity.data = sanitizeTx(lcdTx)
      txEntity.timestamp = new Date(lcdTx.timestamp)
      txEntity.block = block
      return txEntity
    })
  )
}

export async function collectTxs(mgr: EntityManager, txHashes: string[], block: BlockEntity): Promise<TxEntity[]> {
  const txEntities = await generateTxEntities(txHashes, block)

  // Skip transactions that have already been successful
  const existingTxs = await mgr.find(TxEntity, { where: { hash: In(txEntities.map((t) => t.hash.toLowerCase())) } })

  existingTxs.forEach((e) => {
    if (!e.data.code) {
      const idx = txEntities.findIndex((t) => t.hash === e.hash)

      if (idx < 0) {
        throw new Error('impossible')
      }

      logger.info(`collectTxs: existing successful tx found: ${e.hash}`)
      txEntities.splice(idx, 1)
    }
  })

  // Save TxEntity
  // NOTE: Do not use printSql, getSql, or getQuery function.
  // It breaks parameter number ordering caused by a bug from TypeORM
  const qb = mgr
    .createQueryBuilder()
    .insert()
    .into(TxEntity)
    .values(txEntities)
    .orUpdate(['timestamp', 'data', 'block_id'], ['chain_id', 'hash'])

  await qb.execute()

  // generate AccountTxEntities
  const accountTxs: AccountTxEntity[] = compact(txEntities)
    .map((txEntity) => generateAccountTxs(txEntity))
    .flat()

  // Save AccountTxEntity to the database
  // chunkify array up to 5,000 elements to avoid SQL parameter overflow
  await Bluebird.mapSeries(chunk(accountTxs, 5000), (chunk) => mgr.save(chunk))

  logger.info(`collectTxs: ${txEntities.length}, accountTxs: ${accountTxs.length}`)
  return txEntities
}

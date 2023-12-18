import * as Bluebird from 'bluebird'
import { getRepository } from 'typeorm'
import { UnvestedEntity } from 'orm'
import { minus, div, plus } from 'lib/math'
import { currencyToDenom, isActiveCurrency } from 'lib/common'
import memoizeCache from 'lib/memoizeCache'
import * as lcd from 'lib/lcd'
import config from 'config'
import { getTotalSupply } from './totalSupply'
import { isToken, getCirculatingSupply as getTokenCirculatingSupply } from 'service/token'
import getLunaBalance from './getLunaBalance'
import { BOND_DENOM } from 'lib/constant'
import { getTxList, GetTxListParam } from 'service/transaction'
import { Validator } from 'koa-joi-controllers'
import { CHAIN_ID_REGEX } from 'lib/constant'
import { getActiveAccounts } from 'service/dashboard'
import axios, { AxiosResponse, AxiosError } from 'axios'
import { SigningStargateClient, SigningStargateClientOptions } from '@cosmjs/stargate'
import { OfflineDirectSigner, DirectSignResponse } from '@cosmjs/proto-signing'
import { SignDoc } from 'cosmjs-types/cosmos/tx/v1beta1/tx'

import { Tendermint34Client } from '@cosmjs/tendermint-rpc'

const getLunaBalanceMemoized = memoizeCache(getLunaBalance, { promise: true, maxAge: 5 * 60 * 1000 /* 5 minutes */ })

function isDateWithinAYear(timestamp: string): boolean {
  const timeDifference = new Date().getTime() - new Date(timestamp).getTime()
  const millisecondsInAYear = 365 * 24 * 60 * 60 * 1000
  return timeDifference < millisecondsInAYear
}

export async function getCirculatingSupply(input: string): Promise<string> {
  if (isToken(input)) {
    return getTokenCirculatingSupply(input)
  }

  const msgKeyMap: Map<string, string> = new Map()
  msgKeyMap.set('bank/MsgSend', 'from_address')
  msgKeyMap.set('staking/MsgUndelegate', 'delegator_address')
  msgKeyMap.set('staking/MsgDelegate', 'delegator_address')

  const denom = isActiveCurrency(input) ? currencyToDenom(input.toLowerCase()) : input
  const [totalSupply, communityPool] = await Promise.all([getTotalSupply(denom), lcd.getCommunityPool()])
  const Joi = Validator.Joi

  const query: GetTxListParam = {
    chainId: config.CHAIN_ID,
    limit: 100
  }

  const result = {
    supply: 0,
    valid: true
  }

  while (result.valid) {
    const txsList = await getTxList(query)

    const txPromises = txsList.txs.map(async (tx) => {
      if (!isDateWithinAYear(tx.timestamp)) {
        result.valid = false
        return 0
      } else {
        return processMessages(tx.tx.value.msg, msgKeyMap, denom)
      }
    })

    const txResults = await Promise.all(txPromises)

    txResults.forEach((supply) => {
      result.supply += supply
    })

    if (!result.valid || !txsList.next) {
      break
    }

    query.offset = txsList.next
  }

  return result.supply.toString()
}

async function processMessages(messages: any[], msgKeyMap: Map<string, string>, denom: string): Promise<number> {
  const supplies = await Promise.all(
    messages.map(async (msg) => {
      if (msgKeyMap.has(msg.type)) {
        const key = msgKeyMap.get(msg.type)
        if (key) {
          const address = msg.value[key]

          // Parallelize balance retrieval
          const balances = await lcd.getBalance(address)

          // Calculate supply for this iteration
          const localSupply = balances
            .filter((coin) => coin.denom === denom)
            .reduce((acc, coin) => acc + parseInt(coin.amount), 0)

          return localSupply
        }
      }
    })
  )

  // Sum up the results after all iterations are completed
  const supply = supplies.reduce((acc, value) => {
    if (typeof acc === 'number' && typeof value === 'number') {
      return acc + value
    }
  }, 0)

  return supply || 0
}

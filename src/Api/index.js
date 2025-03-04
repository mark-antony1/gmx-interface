import { ethers } from 'ethers';
import { gql } from '@apollo/client'
import { useState, useEffect, useMemo, useCallback } from 'react'
import { Token as UniToken } from '@uniswap/sdk-core'
import { Pool } from '@uniswap/v3-sdk'
import useSWR from 'swr'

import OrderBook from '../abis/OrderBook.json'
import Vault from '../abis/Vault.json'
import Router from '../abis/Router.json'
import UniPool from '../abis/UniPool.json'
import UniswapV2 from '../abis/UniswapV2.json'
import Token from '../abis/Token.json'

import { getContract } from '../Addresses'
import { getConstant } from '../Constants'
import {
  ARBITRUM,
  AVALANCHE,
  // DEFAULT_GAS_LIMIT,
  bigNumberify,
  getExplorerUrl,
  getServerBaseUrl,
  getGasLimit,
  replaceNativeTokenAddress,
  getProvider,
  getOrderKey,
  fetcher,
  parseValue,
  expandDecimals,
  helperToast
} from '../Helpers'
import {
  getTokenBySymbol
} from '../data/Tokens'

import {
  nissohGraphClient,
  arbitrumGraphClient,
  avalancheGraphClient
} from './common'
export * from './prices'

const { AddressZero } = ethers.constants

function getGmxGraphClient(chainId) {
  if (chainId === ARBITRUM) {
    return arbitrumGraphClient
  } else if (chainId === AVALANCHE) {
    return avalancheGraphClient
  }
  throw new Error(`Unsupported chain ${chainId}`)
}

export function useAllOrdersStats(chainId) {
  const query = gql(`{
    orderStat(id: "total") {
      openSwap
      openIncrease
      openDecrease
      executedSwap
      executedIncrease
      executedDecrease
      cancelledSwap
      cancelledIncrease
      cancelledDecrease
    }
  }`)

  const [res, setRes] = useState()

  useEffect(() => {
    getGmxGraphClient(chainId).query({ query }).then(setRes).catch(console.warn)
  }, [setRes, query, chainId])

  return res ? res.data.orderStat : null
}

export function useUserStat(chainId) {
  const query = gql(`{
    userStat(id: "total") {
      id
      uniqueCount
    }
  }`)

  const [res, setRes] = useState()

  useEffect(() => {
    getGmxGraphClient(chainId).query({ query }).then(setRes).catch(console.warn)
  }, [setRes, query, chainId])

  return res ? res.data.userStat : null
}

export function useLiquidationsData(chainId, account) {
  const [data, setData] = useState(null)
  useEffect(() => {
    if (chainId === ARBITRUM && account) {
      const query = gql(`{
         liquidatedPositions(
           where: {account: "${account.toLowerCase()}"}
           first: 100
           orderBy: timestamp
           orderDirection: desc
         ) {
           key
           timestamp
           borrowFee
           loss
           collateral
           size
           markPrice
           type
         }
      }`)
      const graphClient = getGmxGraphClient(chainId)
      graphClient.query({ query }).then(res => {
        const _data = res.data.liquidatedPositions.map(item => {
          return {
            ...item,
            size: bigNumberify(item.size),
            collateral: bigNumberify(item.collateral),
            markPrice: bigNumberify(item.markPrice)
          }
        })
        setData(_data)
      }).catch(console.warn)
    }
  }, [setData, chainId, account])

  return data
}

export function useAllPositions(chainId, library) {
  const count = 1000
  const query = gql(`{
    aggregatedTradeOpens(
      first: ${count}
    ) {
      account
      initialPosition{
        indexToken
        collateralToken
        isLong
        sizeDelta
      }
      increaseList {
        sizeDelta
      }
      decreaseList {
        sizeDelta
      }
    }
  }`)

  const [res, setRes] = useState()

  useEffect(() => {
    nissohGraphClient.query({ query }).then(setRes).catch(console.warn)
  }, [setRes, query])

  const key = res ? `allPositions${count}__` : false
  const { data: positions = [] } = useSWR(key, async () => {
    const provider = getProvider(library, chainId)
    const vaultAddress = getContract(chainId, "Vault")
    const contract = new ethers.Contract(vaultAddress, Vault.abi, provider)
    const ret = await Promise.all(res.data.aggregatedTradeOpens.map(async dataItem => {
      try {
        const { indexToken, collateralToken, isLong } = dataItem.initialPosition
        const positionData = await contract.getPosition(dataItem.account, collateralToken, indexToken, isLong)
        const position = {
          size: bigNumberify(positionData[0]),
          collateral: bigNumberify(positionData[1]),
          entryFundingRate: bigNumberify(positionData[3]),
          account: dataItem.account
        }
        position.fundingFee = await contract.getFundingFee(collateralToken, position.size, position.entryFundingRate)
        position.marginFee = position.size.div(1000)
        position.fee = position.fundingFee.add(position.marginFee)

        const THRESHOLD = 5000
        const collateralDiffPercent = position.fee.mul(10000).div(position.collateral)
        position.danger = collateralDiffPercent.gt(THRESHOLD)

        return position
      } catch (ex) {
        console.error(ex)
      }
    }))

    return ret.filter(Boolean)
  })

  return positions
}

export function useAllOrders(chainId, library) {
  const query = gql(`{
    orders(
      first: 1000,
      orderBy: createdTimestamp,
      orderDirection: desc,
      where: {status: "open"}
    ) {
      type
      account
      index
      status
      createdTimestamp
    }
  }`)

  const [res, setRes] = useState()

  useEffect(() => {
    getGmxGraphClient(chainId).query({ query }).then(setRes)
  }, [setRes, query, chainId])

  const key = res ? res.data.orders.map(order => `${order.type}-${order.account}-${order.index}`) : null
  const { data: orders = [] } = useSWR(key, () => {
    const provider = getProvider(library, chainId)
    const orderBookAddress = getContract(chainId, "OrderBook")
    const contract = new ethers.Contract(orderBookAddress, OrderBook.abi, provider)
    return Promise.all(res.data.orders.map(async order => {
      try {
        const type = order.type.charAt(0).toUpperCase() + order.type.substring(1)
        const method = `get${type}Order`
        const orderFromChain = await contract[method](order.account, order.index)
        const ret = {}
        for (const [key, val] of Object.entries(orderFromChain)) {
          ret[key] = val
        }
        if (order.type === "swap") {
          ret.path = [ret.path0, ret.path1, ret.path2].filter(address => address !== AddressZero)
        }
        ret.type = type
        ret.index = order.index
        ret.account = order.account
        ret.createdTimestamp = order.createdTimestamp
        return ret
      } catch (ex) {
        console.error(ex)
      }
    }))
  })

  return orders.filter(Boolean)
}

export function usePositionsForOrders(chainId, library, orders) {
  const key = orders ? orders.map(order => getOrderKey(order) + '____') : null
  const { data: positions = {} } = useSWR(key, async () => {
    const provider = getProvider(library, chainId)
    const vaultAddress = getContract(chainId, "Vault")
    const contract = new ethers.Contract(vaultAddress, Vault.abi, provider)
    const data = await Promise.all(orders.map(async order => {
      try {
        const position = await contract.getPosition(order.account, order.collateralToken, order.indexToken, order.isLong)
        if (position[0].eq(0)) {
          return [null, order]
        }
        return [position, order]
      } catch (ex) {
        console.error(ex)
      }
    }))
    return data.reduce((memo, [position, order]) => {
      memo[getOrderKey(order)] = position
      return memo
    }, {})
  })

  return positions
}

function invariant(condition, errorMsg) {
  if (!condition) {
    throw new Error(errorMsg)
  }
}

export function useTrades(chainId, account) {
  const url = (account && account.length > 0) ? `${getServerBaseUrl(chainId)}/actions?account=${account}` : `${getServerBaseUrl(chainId)}/actions`
  const { data: trades, mutate: updateTrades } = useSWR(url, {
    dedupingInterval: 30000,
    fetcher: (...args) => fetch(...args).then(res => res.json())
  })

  return { trades, updateTrades }
}

export function useStakedGmxSupply(library, active) {
  const chainId = ARBITRUM
  const gmxAddress = getContract(chainId, "GMX")
  const stakedGmxTrackerAddress = getContract(chainId, "StakedGmxTracker")

  const { data, mutate } = useSWR([`StakeV2:stakedGmxSupply:${active}`, chainId, gmxAddress, "balanceOf", stakedGmxTrackerAddress], {
    fetcher: fetcher(library, Token),
  })

  return { data, mutate }
}

export function useGmxPrice(chainId, libraries, active) {
  const arbitrumLibrary = libraries && libraries.arbitrum ? libraries.arbitrum : undefined
  const { data: gmxPriceFromArbitrum, mutate: mutateFromArbitrum } = useGmxPriceFromArbitrum(arbitrumLibrary, active)
  const { data: gmxPriceFromAvalanche, mutate: mutateFromAvalanche } = useGmxPriceFromAvalanche()

  const gmxPrice = chainId === ARBITRUM ? gmxPriceFromArbitrum : gmxPriceFromAvalanche
  const mutate = useCallback(() => {
    mutateFromAvalanche()
    mutateFromArbitrum()
  }, [mutateFromAvalanche, mutateFromArbitrum])

  return {
    gmxPrice,
    gmxPriceFromArbitrum,
    gmxPriceFromAvalanche,
    mutate
  }
}

function useGmxPriceFromAvalanche() {
  const poolAddress = getContract(AVALANCHE, "TraderJoeGmxAvaxPool")

  const { data, mutate: updateReserves } = useSWR(["TraderJoeGmxAvaxReserves", AVALANCHE, poolAddress, "getReserves"], {
    fetcher: fetcher(undefined, UniswapV2)
  })
  const { _reserve0: gmxReserve, _reserve1: avaxReserve } = data || {}

  const vaultAddress = getContract(AVALANCHE, "Vault")
  const avaxAddress = getTokenBySymbol(AVALANCHE, "WAVAX").address
  const { data: avaxPrice, mutate: updateAvaxPrice } = useSWR([`StakeV2:avaxPrice`, AVALANCHE, vaultAddress, "getMinPrice", avaxAddress], {
    fetcher: fetcher(undefined, Vault),
  })

  const PRECISION = bigNumberify(10).pow(18)
  let gmxPrice
  if (avaxReserve && gmxReserve && avaxPrice) {
    gmxPrice = avaxReserve.mul(PRECISION).div(gmxReserve).mul(avaxPrice).div(PRECISION)
  }

  const mutate = useCallback(() => {
    updateReserves(undefined, true)
    updateAvaxPrice(undefined, true)
  }, [updateReserves, updateAvaxPrice])

  return { data: gmxPrice, mutate }
}

function useGmxPriceFromArbitrum(library, active) {
  const poolAddress = getContract(ARBITRUM, "UniswapGmxEthPool")
  const { data: uniPoolSlot0, mutate: updateUniPoolSlot0 } = useSWR([`StakeV2:uniPoolSlot0:${active}`, ARBITRUM, poolAddress, "slot0"], {
    fetcher: fetcher(library, UniPool),
  })

  const vaultAddress = getContract(ARBITRUM, "Vault")
  const ethAddress = getTokenBySymbol(ARBITRUM, "WETH").address
  const { data: ethPrice, mutate: updateEthPrice } = useSWR([`StakeV2:ethPrice:${active}`, ARBITRUM, vaultAddress, "getMinPrice", ethAddress], {
    fetcher: fetcher(library, Vault),
  })

  const gmxPrice = useMemo(() => {
    if (uniPoolSlot0 && ethPrice) {
      const tokenA = new UniToken(ARBITRUM, ethAddress, 18, "SYMBOL", "NAME")

      const gmxAddress = getContract(ARBITRUM, "GMX")
      const tokenB = new UniToken(ARBITRUM, gmxAddress, 18, "SYMBOL", "NAME")

      const pool = new Pool(
        tokenA, // tokenA
        tokenB, // tokenB
        10000, // fee
        uniPoolSlot0.sqrtPriceX96, // sqrtRatioX96
        1, // liquidity
        uniPoolSlot0.tick, // tickCurrent
        []
      )

      const poolTokenPrice = pool.priceOf(tokenB).toSignificant(6)
      const poolTokenPriceAmount = parseValue(poolTokenPrice, 18)
      return poolTokenPriceAmount.mul(ethPrice).div(expandDecimals(1, 18))
    }
  }, [ethPrice, uniPoolSlot0, ethAddress])

  const mutate = useCallback(() => {
    updateUniPoolSlot0(undefined, true)
    updateEthPrice(undefined, true)
  }, [updateEthPrice, updateUniPoolSlot0])

  return { data: gmxPrice, mutate }
}


export async function approvePlugin(chainId, pluginAddress, { library, pendingTxns, setPendingTxns }) {
  const routerAddress = getContract(chainId, "Router")
  const contract = new ethers.Contract(routerAddress, Router.abi, library.getSigner())
  return callContract(chainId, contract, 'approvePlugin', [pluginAddress], {
    sentMsg: 'Enable orders sent',
    failMsg: 'Enable orders failed',
    pendingTxns,
    setPendingTxns
  })
}

export async function createSwapOrder(
  chainId,
  library,
  path,
  amountIn,
  minOut,
  triggerRatio,
  nativeTokenAddress,
  opts = {}
) {
  const executionFee = getConstant(chainId, 'SWAP_ORDER_EXECUTION_GAS_FEE')
  const triggerAboveThreshold = false
  let shouldWrap = false
  let shouldUnwrap = false
  opts.value = executionFee

  if (path[0] === AddressZero) {
    shouldWrap = true
    opts.value = opts.value.add(amountIn)
  }
  if (path[path.length - 1] === AddressZero) {
    shouldUnwrap = true
  }
  path = replaceNativeTokenAddress(path, nativeTokenAddress)

  const params = [
    path,
    amountIn,
    minOut,
    triggerRatio,
    triggerAboveThreshold,
    executionFee,
    shouldWrap,
    shouldUnwrap
  ]

  const orderBookAddress = getContract(chainId, "OrderBook")
  const contract = new ethers.Contract(orderBookAddress, OrderBook.abi, library.getSigner())

  return callContract(chainId, contract, 'createSwapOrder', params, opts)
}

export async function createIncreaseOrder(
  chainId,
  library,
  nativeTokenAddress,
  path,
  amountIn,
  indexTokenAddress,
  minOut,
  sizeDelta,
  collateralTokenAddress,
  isLong,
  triggerPrice,
  opts = {}
) {
  invariant(!isLong || indexTokenAddress === collateralTokenAddress, "invalid token addresses")
  invariant(indexTokenAddress !== AddressZero, "indexToken is 0")
  invariant(collateralTokenAddress !== AddressZero, "collateralToken is 0")

  const fromETH = path[0] === AddressZero

  path = replaceNativeTokenAddress(path, nativeTokenAddress)
  const shouldWrap = fromETH
  const triggerAboveThreshold = !isLong
  const executionFee = getConstant(chainId, 'INCREASE_ORDER_EXECUTION_GAS_FEE')

  const params = [
    path,
    amountIn,
    indexTokenAddress,
    minOut,
    sizeDelta,
    collateralTokenAddress,
    isLong,
    triggerPrice,
    triggerAboveThreshold,
    executionFee,
    shouldWrap
  ]

  if (!opts.value) {
    opts.value = fromETH ? amountIn.add(executionFee) : executionFee
  }

  const orderBookAddress = getContract(chainId, "OrderBook")
  const contract = new ethers.Contract(orderBookAddress, OrderBook.abi, library.getSigner())

  return callContract(chainId, contract, 'createIncreaseOrder', params, opts)
}

export async function createDecreaseOrder(
  chainId,
  library,
  indexTokenAddress,
  sizeDelta,
  collateralTokenAddress,
  collateralDelta,
  isLong,
  triggerPrice,
  triggerAboveThreshold,
  opts = {}
) {
  invariant(!isLong || indexTokenAddress === collateralTokenAddress, "invalid token addresses")
  invariant(indexTokenAddress !== AddressZero, "indexToken is 0")
  invariant(collateralTokenAddress !== AddressZero, "collateralToken is 0")

  const executionFee = getConstant(chainId, 'DECREASE_ORDER_EXECUTION_GAS_FEE')

  const params = [
    indexTokenAddress,
    sizeDelta,
    collateralTokenAddress,
    collateralDelta,
    isLong,
    triggerPrice,
    triggerAboveThreshold
  ];
  opts.value = executionFee
  const orderBookAddress = getContract(chainId, "OrderBook")
  const contract = new ethers.Contract(orderBookAddress, OrderBook.abi, library.getSigner())

  return callContract(chainId, contract, 'createDecreaseOrder', params, opts)
}

export async function cancelSwapOrder(chainId, library, index, opts) {
  const params = [index];
  const method = 'cancelSwapOrder';
  const orderBookAddress = getContract(chainId, "OrderBook")
  const contract = new ethers.Contract(orderBookAddress, OrderBook.abi, library.getSigner())

  return callContract(chainId, contract, method, params, opts);
}

export async function cancelDecreaseOrder(chainId, library, index, opts) {
  const params = [index];
  const method = 'cancelDecreaseOrder';
  const orderBookAddress = getContract(chainId, "OrderBook")
  const contract = new ethers.Contract(orderBookAddress, OrderBook.abi, library.getSigner())

  return callContract(chainId, contract, method, params, opts);
}

export async function cancelIncreaseOrder(chainId, library, index, opts) {
  const params = [index];
  const method = 'cancelIncreaseOrder';
  const orderBookAddress = getContract(chainId, "OrderBook")
  const contract = new ethers.Contract(orderBookAddress, OrderBook.abi, library.getSigner())

  return callContract(chainId, contract, method, params, opts);
}

export async function updateDecreaseOrder(chainId, library, index, collateralDelta, sizeDelta, triggerPrice, triggerAboveThreshold, opts) {
  const params = [index, collateralDelta, sizeDelta, triggerPrice, triggerAboveThreshold]
  const method = 'updateDecreaseOrder';
  const orderBookAddress = getContract(chainId, "OrderBook")
  const contract = new ethers.Contract(orderBookAddress, OrderBook.abi, library.getSigner())

  return callContract(chainId, contract, method, params, opts);
}

export async function updateIncreaseOrder(chainId, library, index, sizeDelta, triggerPrice, triggerAboveThreshold, opts) {
  const params = [index, sizeDelta, triggerPrice, triggerAboveThreshold];
  const method = 'updateIncreaseOrder';
  const orderBookAddress = getContract(chainId, "OrderBook")
  const contract = new ethers.Contract(orderBookAddress, OrderBook.abi, library.getSigner())

  return callContract(chainId, contract, method, params, opts);
}

export async function updateSwapOrder(chainId, library, index, minOut, triggerRatio, triggerAboveThreshold, opts) {
  const params = [index, minOut, triggerRatio, triggerAboveThreshold];
  const method = 'updateSwapOrder';
  const orderBookAddress = getContract(chainId, "OrderBook")
  const contract = new ethers.Contract(orderBookAddress, OrderBook.abi, library.getSigner())

  return callContract(chainId, contract, method, params, opts);
}

export async function _executeOrder(chainId, library, method, account, index, feeReceiver, opts) {
  const params = [account, index, feeReceiver];
  const orderBookAddress = getContract(chainId, "OrderBook")
  const contract = new ethers.Contract(orderBookAddress, OrderBook.abi, library.getSigner())
  return callContract(chainId, contract, method, params, opts);
}

export function executeSwapOrder(chainId, library, account, index, feeReceiver, opts) {
  return _executeOrder(chainId, library, 'executeSwapOrder', account, index, feeReceiver, opts);
}

export function executeIncreaseOrder(chainId, library, account, index, feeReceiver, opts) {
  return _executeOrder(chainId, library, 'executeIncreaseOrder', account, index, feeReceiver, opts);
}

export function executeDecreaseOrder(chainId, library, account, index, feeReceiver, opts) {
  return _executeOrder(chainId, library, 'executeDecreaseOrder', account, index, feeReceiver, opts);
}

const NOT_ENOUGH_FUNDS = 'NOT_ENOUGH_FUNDS'
const USER_DENIED = 'USER_DENIED'
const SLIPPAGE = 'SLIPPAGE'
const TX_ERROR_PATTERNS = {
  [NOT_ENOUGH_FUNDS]: ["not enough funds for gas", "failed to execute call with revert code InsufficientGasFunds"],
  [USER_DENIED]: ["User denied transaction signature"],
  [SLIPPAGE]: ["Router: mark price lower than limit", "Router: mark price higher than limit"]
}
export function extractError(ex) {
  if (!ex) {
    return []
  }
  const message = ex.data?.message || ex.message
  if (!message) {
    return []
  }
  for (const [type, patterns] of Object.entries(TX_ERROR_PATTERNS)) {
    for (const pattern of patterns) {
      if (message.includes(pattern)) {
        return [message, type]
      }
    }
  }
  return [message]
}

function ToastifyDebug(props) {
  const [open, setOpen] = useState(false)
  return (
    <div className="Toastify-debug">
      {!open &&
        <span className="Toastify-debug-button" onClick={() => setOpen(true)}>Show error</span>
      }
      {open &&
        props.children
      }
    </div>
  )
}

export async function callContract(chainId, contract, method, params, opts) {
  try {
    if (!Array.isArray(params) && typeof params === 'object' && opts === undefined) {
      opts = params
      params = []
    }
    if (!opts) {
      opts = {}
    }

    if (!opts.gasLimit) {
      opts.gasLimit = await getGasLimit(contract, method, params, opts.value)
    }

    // if (opts.gasLimit.lt(DEFAULT_GAS_LIMIT)) {
    //   opts.gasLimit = bigNumberify(DEFAULT_GAS_LIMIT)
    // }

    const res = await contract[method](...params, { gasLimit: opts.gasLimit, value: opts.value })
    const txUrl = getExplorerUrl(chainId) + "tx/" + res.hash
    const sentMsg = opts.sentMsg || "Transaction sent."
    helperToast.success(
      <div>
        {sentMsg} <a href={txUrl} target="_blank" rel="noopener noreferrer">View status.</a>
        <br/>
      </div>
    );
    if (opts.setPendingTxns) {
      const pendingTxn = {
        hash: res.hash,
        message: opts.successMsg || "Transaction completed."
      }
      opts.setPendingTxns(pendingTxns => [...pendingTxns, pendingTxn])
    }
    return res;
  } catch (e) {
    let failMsg
    const [message, type] = extractError(e)
    switch (type) {
      case NOT_ENOUGH_FUNDS:
        failMsg = (<div>
          There is not enough ETH in your account on Arbitrum to send this transaction.<br/>
          <br/>
          <a href={"https://arbitrum.io/bridge-tutorial/"} target="_blank" rel="noopener noreferrer">Bridge ETH to Arbitrum</a>
        </div>)
        break
      case USER_DENIED:
        failMsg = "Transaction was cancelled."
        break
      case SLIPPAGE:
        failMsg = "The mark price has changed, consider increasing your Slippage Tolerance by clicking on the \"...\" icon next to your address."
        break
      default:
        failMsg = (<div>
          {opts.failMsg || "Transaction failed."}<br/>
          {message &&
            <ToastifyDebug>
              {message}
            </ToastifyDebug>
          }
        </div>)
    }
    helperToast.error(failMsg);
    throw e
  }
}

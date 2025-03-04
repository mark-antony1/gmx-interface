import React, { useEffect, useState, useMemo, useCallback } from 'react'

import { useWeb3React } from '@web3-react/core'
import useSWR from 'swr'
import { ethers } from 'ethers'

import {
  FUNDING_RATE_PRECISION,
  BASIS_POINTS_DIVISOR,
  SWAP,
  LONG,
  SHORT,
  bigNumberify,
  getTokenInfo,
  fetcher,
  expandDecimals,
  getPositionKey,
  getLeverage,
  useLocalStorageSerializeKey,
  useLocalStorageByChainId,
  getDeltaStr,
  useChainId,
  getInfoTokens,
  useAccountOrders
} from '../../Helpers'
import { getConstant } from '../../Constants'
import { approvePlugin } from '../../Api'

import { getContract } from '../../Addresses'
import { getTokens, getToken, getWhitelistedTokens, getTokenBySymbol } from '../../data/Tokens'

import Reader from '../../abis/ReaderV2.json'
import VaultV2 from '../../abis/VaultV2.json'
import Token from '../../abis/Token.json'
import Router from '../../abis/Router.json'

import Checkbox from '../../components/Checkbox/Checkbox'
import SwapBox from '../../components/Exchange/SwapBox'
import ExchangeTVChart from '../../components/Exchange/ExchangeTVChart'
import PositionsList from '../../components/Exchange/PositionsList'
import OrdersList from '../../components/Exchange/OrdersList'
import TradeHistory from '../../components/Exchange/TradeHistory'
import ExchangeWalletTokens from '../../components/Exchange/ExchangeWalletTokens'
import ExchangeBanner from '../../components/Exchange/ExchangeBanner'
import Tab from '../../components/Tab/Tab'
import Footer from "../../Footer"

import './Exchange.css';

const { AddressZero } = ethers.constants

function getFundingFee(data) {
  let { entryFundingRate, cumulativeFundingRate, size } = data
  if (entryFundingRate && cumulativeFundingRate) {
    return size.mul(cumulativeFundingRate.sub(entryFundingRate)).div(FUNDING_RATE_PRECISION)
  }
  return
}

const getTokenAddress = (token, nativeTokenAddress) => {
  if (token.address === AddressZero) {
    return nativeTokenAddress
  }
  return token.address
}

export function getPositions(chainId, positionQuery, positionData, infoTokens, includeDelta) {
  const propsLength = getConstant(chainId, "positionReaderPropsLength")
  const positions = []
  const positionsMap = {}
  if (!positionData) {
    return { positions, positionsMap }
  }
  const { collateralTokens, indexTokens, isLong } = positionQuery
  for (let i = 0; i < collateralTokens.length; i++) {
    const collateralToken = getTokenInfo(infoTokens, collateralTokens[i], true, getContract(chainId, "NATIVE_TOKEN"))
    const indexToken = getTokenInfo(infoTokens, indexTokens[i], true, getContract(chainId, "NATIVE_TOKEN"))
    const key = getPositionKey(collateralTokens[i], indexTokens[i], isLong[i])

    const position = {
      key,
      collateralToken,
      indexToken,
      isLong: isLong[i],
      size: positionData[i * propsLength],
      collateral: positionData[i * propsLength + 1],
      averagePrice: positionData[i * propsLength + 2],
      entryFundingRate: positionData[i * propsLength + 3],
      cumulativeFundingRate: collateralToken.cumulativeFundingRate,
      hasRealisedProfit: positionData[i * propsLength + 4].eq(1),
      realisedPnl: positionData[i * propsLength + 5],
      lastIncreasedTime: positionData[i * propsLength + 6].toNumber(),
      hasProfit: positionData[i * propsLength + 7].eq(1),
      delta: positionData[i * propsLength + 8],
      markPrice: isLong[i] ? indexToken.minPrice : indexToken.maxPrice
    }

    let fundingFee = getFundingFee(position)
    position.fundingFee = fundingFee ? fundingFee : bigNumberify(0)
    position.collateralAfterFee = position.collateral.sub(position.fundingFee)

    position.hasLowCollateral = position.collateralAfterFee.lte(0) || position.size.div(position.collateralAfterFee.abs()).gt(50)

    position.pendingDelta = position.delta
    if (position.collateral.gt(0)) {
      if (position.delta.eq(0) && position.averagePrice && position.markPrice) {
        const priceDelta = position.averagePrice.gt(position.markPrice) ? position.averagePrice.sub(position.markPrice) : position.markPrice.sub(position.averagePrice)
        position.pendingDelta = position.size.mul(priceDelta).div(position.averagePrice)
      }
      position.deltaPercentage = position.pendingDelta.mul(BASIS_POINTS_DIVISOR).div(position.collateral)

      const { deltaStr, deltaPercentageStr } = getDeltaStr({
        delta: position.pendingDelta,
        deltaPercentage: position.deltaPercentage,
        hasProfit: position.hasProfit
      })

      position.deltaStr = deltaStr
      position.deltaPercentageStr = deltaPercentageStr

      let netValue = position.hasProfit ? position.collateral.add(position.pendingDelta) : position.collateral.sub(position.pendingDelta)
      position.netValue = netValue.sub(position.fundingFee)
    }

    position.leverage = getLeverage({
      size: position.size,
      collateral: position.collateral,
      entryFundingRate: position.entryFundingRate,
      cumulativeFundingRate: position.cumulativeFundingRate,
      hasProfit: position.hasProfit,
      delta: position.delta,
      includeDelta
    })

    positionsMap[key] = position

    if (position.size.gt(0)) {
      positions.push(position)
    }
  }

  return { positions, positionsMap }
}

export function getPositionQuery(tokens, nativeTokenAddress) {
  const collateralTokens = []
  const indexTokens = []
  const isLong = []

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.isStable) { continue }
    if (token.isWrapped) { continue }
    collateralTokens.push(getTokenAddress(token, nativeTokenAddress))
    indexTokens.push(getTokenAddress(token, nativeTokenAddress))
    isLong.push(true)
  }

  for (let i = 0; i < tokens.length; i++) {
    const stableToken = tokens[i]
    if (!stableToken.isStable) { continue }

    for (let j = 0; j < tokens.length; j++) {
      const token = tokens[j]
      if (token.isStable) { continue }
      if (token.isWrapped) { continue }
      collateralTokens.push(stableToken.address)
      indexTokens.push(getTokenAddress(token, nativeTokenAddress))
      isLong.push(false)
    }
  }

  return { collateralTokens, indexTokens, isLong }
}

export default function Exchange({ savedIsPnlInLeverage, setSavedIsPnlInLeverage, savedSlippageAmount, pendingTxns, setPendingTxns, savedShouldShowPositionLines, setSavedShouldShowPositionLines, connectWallet }) {
  const [showBanner, setShowBanner] = useLocalStorageSerializeKey('showBanner', true)
  const [bannerHidden, setBannerHidden] = useLocalStorageSerializeKey('bannerHidden', null)

  const hideBanner = () => {
    const hiddenLimit = new Date(new Date().getTime()+(2*24*60*60*1000));
    setBannerHidden(hiddenLimit)
    setShowBanner(false)
  }

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [])

  useEffect(() => {
    if (new Date() > new Date('2021-11-30')) {
      setShowBanner(false)
    } else {
      if (bannerHidden && new Date(bannerHidden) > new Date()) {
        setShowBanner(false)
      } else {
        setBannerHidden(null)
        setShowBanner(true)
      }
    }
  }, [showBanner, bannerHidden, setBannerHidden, setShowBanner])

  const { active, account, library } = useWeb3React()
  const { chainId } = useChainId()

  const nativeTokenAddress = getContract(chainId, "NATIVE_TOKEN")

  const vaultAddress = getContract(chainId, "Vault")
  const readerAddress = getContract(chainId, "Reader")
  const usdgAddress = getContract(chainId, "USDG")

  const whitelistedTokens = getWhitelistedTokens(chainId)
  const whitelistedTokenAddresses = whitelistedTokens.map(token => token.address)

  const positionQuery = getPositionQuery(whitelistedTokens, nativeTokenAddress)

  const defaultCollateralSymbol = getConstant(chainId, "defaultCollateralSymbol")
  const defaultTokenSelection = useMemo(() => ({
    [SWAP]: {
      from: AddressZero,
      to: getTokenBySymbol(chainId, defaultCollateralSymbol).address,
    },
    [LONG]: {
      from: AddressZero,
      to: AddressZero,
    },
    [SHORT]: {
      from: getTokenBySymbol(chainId, defaultCollateralSymbol).address,
      to: AddressZero,
    }
  }), [chainId, defaultCollateralSymbol])

  const [tokenSelection, setTokenSelection] = useLocalStorageByChainId(chainId, "Exchange-token-selection-v2", defaultTokenSelection)
  const [swapOption, setSwapOption] = useLocalStorageByChainId(chainId, 'Swap-option-v2', LONG)

  const fromTokenAddress = tokenSelection[swapOption].from
  const toTokenAddress = tokenSelection[swapOption].to

  const setFromTokenAddress = useCallback((selectedSwapOption, address) => {
    const newTokenSelection = JSON.parse(JSON.stringify(tokenSelection))
    newTokenSelection[selectedSwapOption].from = address
    setTokenSelection(newTokenSelection)
  }, [tokenSelection, setTokenSelection])

  const setToTokenAddress = useCallback((selectedSwapOption, address) => {
    const newTokenSelection = JSON.parse(JSON.stringify(tokenSelection))
    newTokenSelection[selectedSwapOption].to = address
    setTokenSelection(newTokenSelection)
  }, [tokenSelection, setTokenSelection])

  const setMarket = (selectedSwapOption, toTokenAddress) => {
    setSwapOption(selectedSwapOption)
    const newTokenSelection = JSON.parse(JSON.stringify(tokenSelection))
    newTokenSelection[selectedSwapOption].to = toTokenAddress
    setTokenSelection(newTokenSelection)
  }

  const [isConfirming, setIsConfirming] = useState(false);
  const [isPendingConfirmation, setIsPendingConfirmation] = useState(false);

  const tokens = getTokens(chainId)
  const { data: vaultTokenInfo, mutate: updateVaultTokenInfo } = useSWR([active, chainId, readerAddress, "getFullVaultTokenInfo"], {
    fetcher: fetcher(library, Reader, [vaultAddress, nativeTokenAddress, expandDecimals(1, 18), whitelistedTokenAddresses]),
  })

  const tokenAddresses = tokens.map(token => token.address)
  const { data: tokenBalances, mutate: updateTokenBalances } = useSWR(active && [active, chainId, readerAddress, "getTokenBalances", account], {
    fetcher: fetcher(library, Reader, [tokenAddresses]),
  })

  const { data: positionData, mutate: updatePositionData } = useSWR(active && [active, chainId, readerAddress, "getPositions", vaultAddress, account], {
    fetcher: fetcher(library, Reader, [positionQuery.collateralTokens, positionQuery.indexTokens, positionQuery.isLong]),
  })

  const { data: fundingRateInfo, mutate: updateFundingRateInfo } = useSWR([active, chainId, readerAddress, "getFundingRates"], {
    fetcher: fetcher(library, Reader, [vaultAddress, nativeTokenAddress, whitelistedTokenAddresses]),
  })

  const { data: totalTokenWeights, mutate: updateTotalTokenWeights } = useSWR([`Exchange:totalTokenWeights:${active}`, chainId, vaultAddress, "totalTokenWeights"], {
    fetcher: fetcher(library, VaultV2),
  })

  const { data: usdgSupply, mutate: updateUsdgSupply } = useSWR([`Exchange:usdgSupply:${active}`, chainId, usdgAddress, "totalSupply"], {
    fetcher: fetcher(library, Token),
  })

  const orderBookAddress = getContract(chainId, "OrderBook")
  const routerAddress = getContract(chainId, "Router")
  const { data: orderBookApproved, mutate: updateOrderBookApproved } = useSWR(active && [active, chainId, routerAddress, "approvedPlugins", account, orderBookAddress], {
    fetcher: fetcher(library, Router)
  });

  useEffect(() => {
    if (active) {
      function onBlock() {
        updateVaultTokenInfo(undefined, true)
        updateTokenBalances(undefined, true)
        updatePositionData(undefined, true)
        updateFundingRateInfo(undefined, true)
        updateTotalTokenWeights(undefined, true)
        updateUsdgSupply(undefined, true)
        updateOrderBookApproved(undefined, true)
      }
      library.on('block', onBlock)
      return () => {
        library.removeListener('block', onBlock)
      }
    }
  }, [active, library, chainId,
      updateVaultTokenInfo, updateTokenBalances, updatePositionData,
      updateFundingRateInfo, updateTotalTokenWeights, updateUsdgSupply,
      updateOrderBookApproved])

  const infoTokens = getInfoTokens(tokens, tokenBalances, whitelistedTokens, vaultTokenInfo, fundingRateInfo)
  const { positions, positionsMap } = getPositions(chainId, positionQuery, positionData, infoTokens, savedIsPnlInLeverage)

  const flagOrdersEnabled = true
  const [orders, updateOrders] = useAccountOrders(flagOrdersEnabled)

  const [isWaitingForPluginApproval, setIsWaitingForPluginApproval] = useState(false);
  const [isPluginApproving, setIsPluginApproving] = useState(false);

  const approveOrderBook = () => {
    setIsPluginApproving(true)
    return approvePlugin(chainId, orderBookAddress, {
      library,
      pendingTxns,
      setPendingTxns
    }).then(() => {
      setIsWaitingForPluginApproval(true)
      updateOrderBookApproved(undefined, true);
    }).finally(() => {
      setIsPluginApproving(false)
    })
  }

  const LIST_SECTIONS = [
    'Positions',
    flagOrdersEnabled ? 'Orders' : undefined,
    'Trades'
  ].filter(Boolean)
  let [listSection, setListSection] = useLocalStorageByChainId(chainId, 'List-section-v2', LIST_SECTIONS[0]);
  const LIST_SECTIONS_LABELS = {
    "Orders": orders.length ? `Orders (${orders.length})` : undefined
  }
  if (!LIST_SECTIONS.includes(listSection)) {
    listSection = LIST_SECTIONS[0]
  }

  if (!getToken(chainId, toTokenAddress)) {
    return null
  }

  const getListSection = () => {
    return (
      <div>
        <div className="Exchange-list-tab-container">
          <Tab
            options={LIST_SECTIONS}
            optionLabels={LIST_SECTIONS_LABELS}
            option={listSection}
            onChange={section => setListSection(section)}
            type="inline"
            className="Exchange-list-tabs"
          />
          <div className="align-right Exchange-should-show-position-lines">
						<Checkbox isChecked={savedShouldShowPositionLines} setIsChecked={setSavedShouldShowPositionLines}>
							<span className="muted">Chart positions</span>
						</Checkbox>
          </div>
        </div>
        {listSection === 'Positions' &&
          <PositionsList
            setListSection={setListSection}
            setIsWaitingForPluginApproval={setIsWaitingForPluginApproval}
            approveOrderBook={approveOrderBook}
            isPluginApproving={isPluginApproving}
            isWaitingForPluginApproval={isWaitingForPluginApproval}
            updateOrderBookApproved={updateOrderBookApproved}
            orderBookApproved={orderBookApproved}
            positions={positions}
            positionsMap={positionsMap}
            infoTokens={infoTokens}
            active={active}
            account={account}
            library={library}
            pendingTxns={pendingTxns}
            setPendingTxns={setPendingTxns}
            flagOrdersEnabled={flagOrdersEnabled}
            savedIsPnlInLeverage={savedIsPnlInLeverage}
            chainId={chainId}
            nativeTokenAddress={nativeTokenAddress}
            setMarket={setMarket}
            orders={orders}
          />
        }
        {listSection === 'Orders' &&
          <OrdersList
            active={active}
            library={library}
            pendingTxns={pendingTxns}
            setPendingTxns={setPendingTxns}
            infoTokens={infoTokens}
            positionsMap={positionsMap}
            chainId={chainId}
            orders={orders}
            updateOrders={updateOrders}
            totalTokenWeights={totalTokenWeights}
            usdgSupply={usdgSupply}
          />
        }
        {listSection === 'Trades' &&
          <TradeHistory
            account={account}
            infoTokens={infoTokens}
            getTokenInfo={getTokenInfo}
            chainId={chainId}
            nativeTokenAddress={nativeTokenAddress}
          />
        }
      </div>
    )
  }

  const onSelectWalletToken = (token) => {
    setFromTokenAddress(swapOption, token.address)
  }

  const renderChart = () => {
    return <ExchangeTVChart
      fromTokenAddress={fromTokenAddress}
      toTokenAddress={toTokenAddress}
      infoTokens={infoTokens}
      swapOption={swapOption}
      chainId={chainId}
      positions={positions}
      savedShouldShowPositionLines={savedShouldShowPositionLines}
      orders={orders}
    />
  }



  return (
    <div className="Exchange page-layout">
      {
        showBanner && <ExchangeBanner hideBanner={hideBanner} />
      }
      <div className="Exchange-content">
        <div className="Exchange-left">

          {renderChart()}
          <div className="Exchange-lists large">
            {getListSection()}
          </div>
        </div>
        <div className="Exchange-right">
          <SwapBox
            setIsWaitingForPluginApproval={setIsWaitingForPluginApproval}
            approveOrderBook={approveOrderBook}
            isPluginApproving={isPluginApproving}
            isWaitingForPluginApproval={isWaitingForPluginApproval}
            updateOrderBookApproved={updateOrderBookApproved}
            orderBookApproved={orderBookApproved}
            orders={orders}
            flagOrdersEnabled={flagOrdersEnabled}
            chainId={chainId}
            infoTokens={infoTokens}
            active={active}
            connectWallet={connectWallet}
            library={library}
            account={account}
            positionsMap={positionsMap}
            fromTokenAddress={fromTokenAddress}
            setFromTokenAddress={setFromTokenAddress}
            toTokenAddress={toTokenAddress}
            setToTokenAddress={setToTokenAddress}
            swapOption={swapOption}
            setSwapOption={setSwapOption}
            pendingTxns={pendingTxns}
            setPendingTxns={setPendingTxns}
            tokenSelection={tokenSelection}
            setTokenSelection={setTokenSelection}
            isConfirming={isConfirming}
            setIsConfirming={setIsConfirming}
            isPendingConfirmation={isPendingConfirmation}
            setIsPendingConfirmation={setIsPendingConfirmation}
            savedIsPnlInLeverage={savedIsPnlInLeverage}
            setSavedIsPnlInLeverage={setSavedIsPnlInLeverage}
            nativeTokenAddress={nativeTokenAddress}
            savedSlippageAmount={savedSlippageAmount}
            totalTokenWeights={totalTokenWeights}
            usdgSupply={usdgSupply}
          />
          <div className="Exchange-wallet-tokens">
            <div className="Exchange-wallet-tokens-content">
              <ExchangeWalletTokens
                tokens={tokens}
                infoTokens={infoTokens}
                onSelectToken={onSelectWalletToken}
              />
            </div>
          </div>
        </div>
        <div className="Exchange-lists small">
          {getListSection()}
        </div>
      </div>
      <Footer />
    </div>
  )
}

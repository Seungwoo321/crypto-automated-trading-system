import { IStrategy, IPosition, IBar, TradeDirection, PositionStatus, IEnterPositionOptions } from '../grademark'
import { Position, exchange } from '../exchange'
import { service as gqlService } from '../gql'
import { IDataFrame } from 'data-forge'
import { Market } from 'ccxt'
import { assert } from 'chai'

/**
 * Update an open position for a new bar.
 *
 * @param position The position to update.
 * @param bar The current bar.
 * @returns
 */
async function updatePosition (position: IPosition, bar: IBar, amount: number, flagNewTralingStop: boolean): Promise<IPosition> {
    position.profit = bar.close - position.entryPrice
    position.profitPct = (position.profit / position.entryPrice) * 100
    position.growth = position.direction === TradeDirection.Long
        ? bar.close / position.entryPrice
        : position.entryPrice / bar.close

    position.holdingPeriod += 1
    if (flagNewTralingStop && typeof position.curStopPrice === 'number') {
        const symbol: string = position.symbol
        await exchange.createOrder(
            symbol,
            'stopLimit',
            position.direction === TradeDirection.Long ? 'sell' : 'buy',
            amount,
            position.curStopPrice,
            {
                stopPrice: position.curStopPrice,
                text: 'traling-stop',
                execInst: 'LastPrice,Close'
            }
        )
    }

    return await gqlService.updatePosition(position)
}

/**
 *
 * @param symbol
 * @param bar
 */
async function trading<InputBarT extends IBar, IndicatorBarT extends InputBarT, ParametersT, IndexT> (
    symbol: string,
    strategy: IStrategy<InputBarT, IndicatorBarT, ParametersT, IndexT>,
    inputSeries: IDataFrame<IndexT, InputBarT>
) {
    if (inputSeries.none()) {
        throw new Error('Expect input data series to contain at last 1 bar.')
    }

    const lookbackPeriod = strategy.lookbackPeriod || 1
    if (inputSeries.count() < lookbackPeriod) {
        throw new Error('You have less input data than your lookback period, the size of your input data should be some multiple of your lookback period.')
    }
    const markets = await exchange.loadMarkets()
    const strategyParameters = strategy.parameters || {} as ParametersT
    let openPosition = await gqlService.getOpenPosition(symbol)
    let newTrailingStopOrder = false
    // const indicatorsSeries = inputSeries as IDataFrame<IndexT, IndicatorBarT>
    let indicatorsSeries: IDataFrame<IndexT, IndicatorBarT>

    //
    // Prepare indicators.
    //
    if (strategy.prepIndicators) {
        indicatorsSeries = strategy.prepIndicators({
            parameters: strategyParameters,
            inputSeries: inputSeries
        })
    } else {
        indicatorsSeries = inputSeries as IDataFrame<IndexT, IndicatorBarT>
    }
    const bar = indicatorsSeries.last()
    console.table([bar])
    const positionStatus = await gqlService.getPositionStatus(symbol)
    const entryPrice = bar.close
    const positionDirection = positionStatus.direction
    const positions: Position[] = await exchange.fetchPositions()
    const currentPosition: Position = positions.find(position => position.symbol === symbol.split(':')[0].replace('/', '')) || {
        isOpen: false,
        currentQty: '0'
    }
    /**
     *
     * @param openPosition
     * @param symbol
     */
    async function createPosition (openPosition: IPosition, symbol: string) {
        const market: Market = markets[symbol]
        const balance = await exchange.fetchBalance()
        let availableMargin: number = balance.BTC.total * 100000000 * (1 - +market.info.initMargin - +market.info.maintMargin)
        if (market.maker) {
            availableMargin += market?.maker
        }
        const amount: number = availableMargin / market.info.multiplier / market.info.prevClosePrice * market.info.lotSize
        const formattedAmount: number = parseFloat(exchange.amountToPrecision(symbol, amount))
        openPosition.amount = formattedAmount
        const formattedPrice: number = parseFloat(exchange.priceToPrecision(symbol, openPosition.entryPrice))
        // cancle all orders
        await exchange.cancelAllOrders()
        // create new order
        await exchange.createOrder(
            symbol,
            'limit',
            openPosition.direction === TradeDirection.Long ? 'buy' : 'sell',
            formattedAmount,
            formattedPrice,
            {
                displayQty: 0,
                text: 'entry-rule'
            }
        )

        // if initial stop price then add stop order
        if (openPosition.initialStopPrice) {
            await exchange.createOrder(
                symbol,
                'stop',
                openPosition.direction === TradeDirection.Long ? 'sell' : 'buy',
                formattedAmount,
                openPosition.initialStopPrice,
                {
                    stopPx: openPosition.initialStopPrice,
                    text: 'stop-loss',
                    execInst: 'LastPrice,Close'
                }
            )
        }

        // if trailing stop loss then add trailing stop order
        if (strategy.trailingStopLoss && openPosition.curStopPrice !== undefined && openPosition.initialStopPrice !== openPosition.curStopPrice) {
            await exchange.createOrder(
                symbol,
                'stopLimit',
                openPosition.direction === TradeDirection.Long ? 'sell' : 'buy',
                formattedAmount,
                openPosition.curStopPrice,
                {
                    ordType: 'stopLimit',
                    stopPx: openPosition.curStopPrice,
                    text: 'traling-stop',
                    execInst: 'LastPrice,Close'

                }
            )
        }
        await gqlService.openPosition(symbol, openPosition)
    }
    /**
     *
     * @param direction
     * @param symbol
     * @param amount
     * @param exitPrice
     * @param exitReason
     * @returns
     */
    async function closePosition (direction: TradeDirection, symbol: string, amount: number, exitPrice: number, exitReason: string) {
        await exchange.createOrder(
            symbol,
            'limit',
            direction === TradeDirection.Long ? 'sell' : 'buy',
            amount,
            exitPrice,
            {
                displayQty: 0,
                text: exitReason,
                execInst: 'ReduceOnly'
            }
        )

        return await gqlService.closePosition(symbol)
    }
    /**
     *
     * @param options
     */
    async function enterPosition (options?: IEnterPositionOptions) {
        assert(positionStatus.value === PositionStatus.None, 'Can only enter a position when not already in one.')
        if (options?.symbol && options?.direction && options?.entryPrice) {
            await gqlService.enterPosition(symbol, options.direction, options.entryPrice)
        }
    }
    /**
     *
     * @param symbol
     * @returns
     */
    async function exitPosition (symbol: string) {
        assert(positionStatus.value === PositionStatus.Position, 'Can only exit a position when we are in a position.')
        return await gqlService.exitPosition(symbol)
    }
    /**
     *
     * @param openPosition
     * @param exitTime
     * @param exitPrice
     * @param exitReason
     * @returns
     */

    switch (positionStatus.value) {
    case PositionStatus.None:
        if (currentPosition?.isOpen) {
            const direction = +currentPosition?.currentQty > 0
                ? TradeDirection.Long
                : TradeDirection.Short
            await closePosition(direction, symbol, Math.abs(+currentPosition.currentQty), bar.close, 'none position')
        }

        await strategy.entryRule(enterPosition, {
            bar,
            parameters: {
                ...strategyParameters,
                symbol,
                entryPrice
            }
        })
        break

    case PositionStatus.Enter:
        assert(openPosition === null, 'Expected there to be no open position initialised yet!')
        if (positionStatus.conditionalEntryPrice !== undefined) {
            if (positionStatus.direction === TradeDirection.Long) {
                if (bar.high < positionStatus.conditionalEntryPrice) {
                    break
                }
            } else {
                if (bar.low > positionStatus.conditionalEntryPrice) {
                    break
                }
            }
        }
        openPosition = {
            symbol,
            direction: positionDirection,
            entryTime: new Date(bar.time),
            entryPrice,
            growth: 1,
            profit: 0,
            profitPct: 0,
            holdingPeriod: 0,
            amount: Number(currentPosition.currentQty)
        }

        if (strategy.stopLoss) {
            const initialStopDistance = strategy.stopLoss({
                entryPrice,
                position: openPosition,
                bar,
                parameters: strategyParameters
            })
            openPosition.initialStopPrice = openPosition.direction === TradeDirection.Long
                ? entryPrice - initialStopDistance
                : entryPrice + initialStopDistance
            openPosition.curStopPrice = parseFloat(exchange.priceToPrecision(symbol, openPosition.initialStopPrice))
            openPosition.initialStopPrice = parseFloat(exchange.priceToPrecision(symbol, openPosition.initialStopPrice))
        }

        if (strategy.trailingStopLoss) {
            const trailingStopDistance = strategy.trailingStopLoss({
                entryPrice,
                position: openPosition,
                bar,
                parameters: strategyParameters
            })

            const trailingStopPrice = openPosition.direction === TradeDirection.Long
                ? entryPrice - trailingStopDistance
                : entryPrice + trailingStopDistance
            if (openPosition.initialStopPrice === undefined) {
                openPosition.initialStopPrice = trailingStopPrice
            } else {
                openPosition.initialStopPrice = openPosition.direction === TradeDirection.Long
                    ? Math.max(openPosition.initialStopPrice, trailingStopPrice)
                    : Math.min(openPosition.initialStopPrice, trailingStopPrice)
            }
            openPosition.curStopPrice = parseFloat(exchange.priceToPrecision(symbol, openPosition.initialStopPrice))
            openPosition.initialStopPrice = parseFloat(exchange.priceToPrecision(symbol, openPosition.initialStopPrice))
        }

        if (strategy.profitTarget) {
            const profitDistance = strategy.profitTarget({
                entryPrice,
                position: openPosition,
                bar,
                parameters: strategyParameters
            })
            openPosition.profitTarget = openPosition.direction === TradeDirection.Long
                ? entryPrice + profitDistance
                : entryPrice - profitDistance
            openPosition.profitTarget = parseFloat(exchange.priceToPrecision(symbol, openPosition.profitTarget))
        }

        if (currentPosition.isOpen) {
            await gqlService.openPosition(symbol, openPosition)
            break
        }

        await createPosition(openPosition, symbol)

        break
    case PositionStatus.Position:
        assert(openPosition !== null, 'Expected open position to already be initialised!')

        if (!currentPosition.isOpen) {
            await exchange.cancelAllOrders()
            await gqlService.closePosition(symbol)
            break
        }

        if (+currentPosition.currentQty !== 0 && openPosition?.curStopPrice) {
            if (openPosition.direction === TradeDirection.Long) {
                if (bar.close <= openPosition.curStopPrice) {
                    await closePosition(openPosition.direction, symbol, Math.abs(+currentPosition.currentQty), bar.close, 'stop-loss')
                    break
                }
            } else if (openPosition.direction === TradeDirection.Short) {
                if (bar.close >= openPosition.curStopPrice) {
                    await closePosition(openPosition.direction, symbol, Math.abs(+currentPosition.currentQty), bar.close, 'stop-loss')
                }
            }
        }

        if (+currentPosition.currentQty !== 0 && openPosition?.profitTarget) {
            if (openPosition.direction === TradeDirection.Long) {
                if (bar.high >= openPosition.profitTarget) {
                    await closePosition(openPosition.direction, symbol, Math.abs(+currentPosition.currentQty), openPosition.profitTarget, 'profit-target')
                    break
                }
            } else {
                if (bar.low <= openPosition.profitTarget) {
                    await closePosition(openPosition.direction, symbol, Math.abs(+currentPosition.currentQty), openPosition.profitTarget, 'profit-target')
                    break
                }
            }
        }

        if (strategy.trailingStopLoss) {
            const trailingStopDistance = strategy.trailingStopLoss({
                entryPrice: openPosition!.entryPrice,
                position: openPosition!,
                bar,
                parameters: strategyParameters
            })
            if (openPosition!.direction === TradeDirection.Long) {
                const newTrailingStopPrice = bar.close - trailingStopDistance
                if (newTrailingStopPrice > openPosition!.curStopPrice!) {
                    openPosition!.curStopPrice = newTrailingStopPrice
                    newTrailingStopOrder = true
                }
            } else {
                const newTrailingStopPrice = bar.close + trailingStopDistance
                if (newTrailingStopPrice < openPosition!.curStopPrice!) {
                    openPosition!.curStopPrice = newTrailingStopPrice
                    newTrailingStopOrder = true
                }
            }
            openPosition!.curStopPrice = parseFloat(exchange.priceToPrecision(symbol, openPosition!.curStopPrice))
        }
        if (+currentPosition.currentQty !== 0) {
            await updatePosition(openPosition!, bar, Math.abs(+currentPosition.currentQty), newTrailingStopOrder)
        }

        if (strategy.exitRule) {
            await strategy.exitRule(exitPosition, {
                entryPrice: openPosition!.entryPrice,
                position: openPosition!,
                bar: bar,
                parameters: {
                    ...strategyParameters,
                    symbol,
                    entryPrice: openPosition!.entryPrice
                }
            })
        }
        break

    case PositionStatus.Exit:
        assert(openPosition !== null, 'Expected open position to already be initialised!')
        if (+currentPosition.currentQty !== 0) {
            closePosition(openPosition!.direction, symbol, Math.abs(+currentPosition.currentQty), bar.close, 'exit-rule')
        }
        break

    default:
        throw new Error('Unexpected state!')
    }
}

export {
    trading
}

"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.trading = void 0;
const grademark_1 = require("../grademark");
const exchange_1 = require("../exchange");
const gql_1 = require("../gql");
const chai_1 = require("chai");
/**
 * Update an open position for a new bar.
 *
 * @param position The position to update.
 * @param bar The current bar.
 * @returns
 */
function updatePosition(position, bar, amount, flagNewTralingStop) {
    return __awaiter(this, void 0, void 0, function* () {
        position.profit = bar.close - position.entryPrice;
        position.profitPct = (position.profit / position.entryPrice) * 100;
        position.growth = position.direction === grademark_1.TradeDirection.Long
            ? bar.close / position.entryPrice
            : position.entryPrice / bar.close;
        position.holdingPeriod += 1;
        if (flagNewTralingStop && typeof position.curStopPrice === 'number') {
            const symbol = position.symbol;
            yield exchange_1.exchange.createOrder(symbol, 'limit', position.direction === grademark_1.TradeDirection.Long ? 'sell' : 'buy', amount, position.curStopPrice, {
                type: 'stopLimit',
                stopPrice: position.curStopPrice,
                text: 'traling-stop',
                execInst: 'LastPrice,Close'
            });
        }
        return yield gql_1.service.updatePosition(position);
    });
}
/**
 *
 * @param symbol
 * @param bar
 */
function trading(symbol, strategy, inputSeries) {
    return __awaiter(this, void 0, void 0, function* () {
        if (inputSeries.none()) {
            throw new Error('Expect input data series to contain at last 1 bar.');
        }
        const lookbackPeriod = strategy.lookbackPeriod || 1;
        if (inputSeries.count() < lookbackPeriod) {
            throw new Error('You have less input data than your lookback period, the size of your input data should be some multiple of your lookback period.');
        }
        const markets = yield exchange_1.exchange.loadMarkets();
        const strategyParameters = strategy.parameters || {};
        let openPosition = yield gql_1.service.getOpenPosition(symbol);
        let newTrailingStopOrder = false;
        // const indicatorsSeries = inputSeries as IDataFrame<IndexT, IndicatorBarT>
        let indicatorsSeries;
        //
        // Prepare indicators.
        //
        if (strategy.prepIndicators) {
            indicatorsSeries = strategy.prepIndicators({
                parameters: strategyParameters,
                inputSeries: inputSeries
            });
        }
        else {
            indicatorsSeries = inputSeries;
        }
        const bar = indicatorsSeries.last();
        const positionStatus = yield gql_1.service.getPositionStatus(symbol);
        const entryPrice = bar.open;
        const positionDirection = positionStatus.direction;
        const currentPosition = yield exchange_1.exchange.fetchPositions(null, {
            filter: {
                symbol
            }
        });
        /**
         *
         * @param openPosition
         * @param symbol
         */
        function createPosition(openPosition, symbol) {
            return __awaiter(this, void 0, void 0, function* () {
                const market = markets[symbol];
                const balance = yield exchange_1.exchange.fetchBalance();
                let availableMargin = balance.BTC.total * 100000000 * (1 - +market.info.initMargin + +market.info.maintMargin);
                if (market.maker) {
                    availableMargin += market === null || market === void 0 ? void 0 : market.maker;
                }
                const amount = availableMargin / market.info.multiplier / market.info.prevClosePrice * market.info.lotSize;
                const formattedAmount = exchange_1.exchange.amountToPrecision(symbol, amount);
                const formattedPrice = exchange_1.exchange.priceToPrecision(symbol, market.info.prevClosePrice);
                // cancle all orders
                yield exchange_1.exchange.cancelAllOrders();
                // create new order
                yield exchange_1.exchange.createOrder(symbol, 'Limit', openPosition.direction === grademark_1.TradeDirection.Long ? 'buy' : 'sell', formattedAmount, formattedPrice, {
                    displayQty: 0,
                    text: 'entry-rule'
                });
                // if initial stop price then add stop order
                if (openPosition.initialStopPrice) {
                    yield exchange_1.exchange.createOrder(symbol, 'Stop', openPosition.direction === grademark_1.TradeDirection.Long ? 'sell' : 'buy', formattedAmount, openPosition.initialStopPrice, {
                        stopPx: openPosition.initialStopPrice,
                        text: 'stop-loss',
                        execInst: 'LastPrice,Close'
                    });
                }
                // if trailing stop loss then add trailing stop order
                if (strategy.trailingStopLoss && openPosition.curStopPrice !== undefined && openPosition.initialStopPrice !== openPosition.curStopPrice) {
                    yield exchange_1.exchange.createOrder(symbol, 'StopLimit', openPosition.direction === grademark_1.TradeDirection.Long ? 'sell' : 'buy', formattedAmount, openPosition.curStopPrice, {
                        stopPx: openPosition.curStopPrice,
                        text: 'traling-stop',
                        execInst: 'LastPrice,Close'
                    });
                }
                yield gql_1.service.openPosition(symbol, openPosition);
            });
        }
        /**
         *
         * @param openPosition
         * @param amount
         * @param exitPrice
         * @param exitReason
         * @returns
         */
        function closePosition(direction, symbol, amount, exitPrice, exitReason) {
            return __awaiter(this, void 0, void 0, function* () {
                yield exchange_1.exchange.createOrder(symbol, 'Limit', direction === grademark_1.TradeDirection.Long ? 'sell' : 'buy', amount, exitPrice, {
                    displayQty: 0,
                    text: exitReason,
                    execInst: 'ReduceOnly'
                });
                return yield gql_1.service.closePosition(symbol);
            });
        }
        /**
         *
         * @param symbol
         * @param direction
         * @param entryPrice
         * @returns
         */
        function enterPosition(options) {
            return __awaiter(this, void 0, void 0, function* () {
                (0, chai_1.assert)(positionStatus.value === grademark_1.PositionStatus.None, 'Can only enter a position when not already in one.');
                if ((options === null || options === void 0 ? void 0 : options.symbol) && (options === null || options === void 0 ? void 0 : options.direction) && (options === null || options === void 0 ? void 0 : options.entryPrice)) {
                    yield gql_1.service.enterPosition(symbol, options.direction, entryPrice);
                }
            });
        }
        /**
         *
         * @param symbol
         * @returns
         */
        function exitPosition(symbol) {
            return __awaiter(this, void 0, void 0, function* () {
                return yield gql_1.service.exitPosition(symbol);
            });
        }
        /**
         *
         * @param openPosition
         * @param exitTime
         * @param exitPrice
         * @param exitReason
         * @returns
         */
        function finalizePosition(openPosition, exitTime, exitPrice, exitReason) {
            const profit = openPosition.direction === grademark_1.TradeDirection.Long
                ? exitPrice - openPosition.entryPrice
                : openPosition.entryPrice - exitPrice;
            return {
                direction: openPosition.direction,
                entryTime: openPosition.entryTime,
                entryPrice: openPosition.entryPrice,
                exitTime: exitTime,
                exitPrice: exitPrice,
                profit: profit,
                profitPct: (profit / openPosition.entryPrice) * 100,
                holdingPeriod: openPosition.holdingPeriod,
                exitReason: exitReason,
                stopPrice: openPosition.initialStopPrice
            };
        }
        switch (+positionStatus.value) {
            case grademark_1.PositionStatus.None:
                if (currentPosition.contracts !== 0) {
                    const direction = currentPosition.contracts > 0
                        ? grademark_1.TradeDirection.Long
                        : grademark_1.TradeDirection.Short;
                    yield enterPosition({ symbol, direction, entryPrice });
                    break;
                }
                yield strategy.entryRule(enterPosition, {
                    bar,
                    parameters: Object.assign(Object.assign({}, strategyParameters), { symbol,
                        entryPrice })
                });
                break;
            case grademark_1.PositionStatus.Enter:
                (0, chai_1.assert)(positionStatus.conditionalEntryPrice === undefined, 'Expected there to be no open position initialised yet!');
                if (positionStatus.conditionalEntryPrice !== undefined) {
                    if (positionStatus.direction === grademark_1.TradeDirection.Long) {
                        if (bar.high < positionStatus.conditionalEntryPrice) {
                            yield gql_1.service.closePosition(symbol);
                            break;
                        }
                    }
                    else {
                        if (bar.low > positionStatus.conditionalEntryPrice) {
                            yield gql_1.service.closePosition(symbol);
                            break;
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
                    holdingPeriod: 0
                };
                if (strategy.stopLoss) {
                    const initialStopDistance = strategy.stopLoss({
                        entryPrice,
                        position: openPosition,
                        bar: bar,
                        parameters: Object.assign(Object.assign({}, strategyParameters), { symbol,
                            entryPrice })
                    });
                    openPosition.initialStopPrice = openPosition.direction === grademark_1.TradeDirection.Long
                        ? entryPrice - initialStopDistance
                        : entryPrice + initialStopDistance;
                    openPosition.curStopPrice = exchange_1.exchange.priceToPrecision(symbol, openPosition.initialStopPrice);
                    openPosition.initialStopPrice = exchange_1.exchange.priceToPrecision(symbol, openPosition.initialStopPrice);
                }
                if (strategy.trailingStopLoss) {
                    const trailingStopDistance = strategy.trailingStopLoss({
                        entryPrice,
                        position: openPosition,
                        bar,
                        parameters: strategyParameters
                    });
                    const trailingStopPrice = openPosition.direction === grademark_1.TradeDirection.Long
                        ? entryPrice - trailingStopDistance
                        : entryPrice + trailingStopDistance;
                    if (openPosition.initialStopPrice === undefined) {
                        openPosition.initialStopPrice = trailingStopPrice;
                    }
                    else {
                        openPosition.initialStopPrice = openPosition.direction === grademark_1.TradeDirection.Long
                            ? Math.max(openPosition.initialStopPrice, trailingStopPrice)
                            : Math.min(openPosition.initialStopPrice, trailingStopPrice);
                    }
                    openPosition.curStopPrice = exchange_1.exchange.priceToPrecision(symbol, openPosition.initialStopPrice);
                    openPosition.initialStopPrice = exchange_1.exchange.priceToPrecision(symbol, openPosition.initialStopPrice);
                }
                if (strategy.profitTarget) {
                    const profitDistance = strategy.profitTarget({
                        entryPrice,
                        position: openPosition,
                        bar,
                        parameters: strategyParameters
                    });
                    openPosition.profitTarget = openPosition.direction === grademark_1.TradeDirection.Long
                        ? entryPrice + profitDistance
                        : entryPrice - profitDistance;
                    openPosition.profitTarget = exchange_1.exchange.priceToPrecision(symbol, openPosition.profitTarget);
                }
                if (currentPosition.contracts !== 0) {
                    yield gql_1.service.openPosition(symbol, openPosition);
                    break;
                }
                yield createPosition(openPosition, symbol);
                break;
            case grademark_1.PositionStatus.Position:
                (0, chai_1.assert)(openPosition !== null, 'Expected open position to already be initialised!');
                if (currentPosition.contracts === 0) {
                    yield exchange_1.exchange.cancelAllOrders();
                    yield gql_1.service.closePosition(symbol);
                    break;
                }
                if (openPosition === null || openPosition === void 0 ? void 0 : openPosition.curStopPrice) {
                    if (openPosition.direction === grademark_1.TradeDirection.Long) {
                        if (bar.close <= openPosition.curStopPrice) {
                            yield closePosition(openPosition.direction, symbol, currentPosition.contracts, bar.close, 'stop-loss');
                            finalizePosition(openPosition, bar.time, bar.close, 'stop-loss');
                            break;
                        }
                    }
                    else if (openPosition.direction === grademark_1.TradeDirection.Short) {
                        if (bar.close >= openPosition.curStopPrice) {
                            yield closePosition(openPosition.direction, symbol, currentPosition.contracts, bar.close, 'stop-loss');
                            finalizePosition(openPosition, bar.time, bar.close, 'stop-loss');
                        }
                    }
                }
                if (openPosition === null || openPosition === void 0 ? void 0 : openPosition.profitTarget) {
                    if (openPosition.direction === grademark_1.TradeDirection.Long) {
                        if (bar.high >= openPosition.profitTarget) {
                            yield closePosition(openPosition.direction, symbol, currentPosition.contracts, openPosition.profitTarget, 'profit-target');
                            finalizePosition(openPosition, bar.time, openPosition.profitTarget, 'profit-target');
                            break;
                        }
                    }
                    else {
                        if (bar.low <= openPosition.profitTarget) {
                            yield closePosition(openPosition.direction, symbol, currentPosition.contracts, openPosition.profitTarget, 'profit-target');
                            finalizePosition(openPosition, bar.time, openPosition.profitTarget, 'profit-target');
                            break;
                        }
                    }
                }
                if (strategy.trailingStopLoss) {
                    const trailingStopDistance = strategy.trailingStopLoss({
                        entryPrice: openPosition.entryPrice,
                        position: openPosition,
                        bar,
                        parameters: strategyParameters
                    });
                    if (openPosition.direction === grademark_1.TradeDirection.Long) {
                        const newTrailingStopPrice = bar.close - trailingStopDistance;
                        if (newTrailingStopPrice > openPosition.curStopPrice) {
                            openPosition.curStopPrice = newTrailingStopPrice;
                            newTrailingStopOrder = true;
                        }
                    }
                    else {
                        const newTrailingStopPrice = bar.close + trailingStopDistance;
                        if (newTrailingStopPrice < openPosition.curStopPrice) {
                            openPosition.curStopPrice = newTrailingStopPrice;
                            newTrailingStopOrder = true;
                        }
                    }
                    openPosition.curStopPrice = exchange_1.exchange.priceToPrecision(symbol, openPosition.curStopPrice);
                }
                yield updatePosition(openPosition, bar, currentPosition.contracts, newTrailingStopOrder);
                if (strategy.exitRule) {
                    yield strategy.exitRule(exitPosition, {
                        entryPrice: openPosition.entryPrice,
                        position: openPosition,
                        bar: bar,
                        parameters: Object.assign(Object.assign({}, strategyParameters), { symbol, entryPrice: openPosition.entryPrice })
                    });
                }
                break;
            case grademark_1.PositionStatus.Exit:
                (0, chai_1.assert)(openPosition !== null, 'Expected open position to already be initialised!');
                closePosition(openPosition.direction, symbol, currentPosition.contracts, bar.open, 'exit-rule');
                break;
            default:
                throw new Error('Unexpected state!');
        }
    });
}
exports.trading = trading;

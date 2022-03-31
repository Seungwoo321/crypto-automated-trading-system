const { DataSource } = require('apollo-datasource')
const { Op } = require('sequelize')
class CompletedTrade extends DataSource {
    constructor (store) {
        super()
        this.store = store
    }

    initialize (config) {
        this.context = config.context
    }

    async findTrading ({ tradingId }) {
        const res = await this.store.findAll({
            where: {
                [Op.eq]: {
                    tradingId
                }
            }
        })
        return res && res.length ? res[0].get() : false
    }

    async findTradingByOrderId ({ orderId }) {
        const res = await this.store.findAll({
            where: {
                [Op.eq]: {
                    orderId
                }
            }
        })
        return res && res.length ? res[0].get() : false
    }

    async findTradingBySymbol ({ symbol }) {
        const res = await this.store.findAll({
            where: {
                [Op.eq]: {
                    symbol
                }
            }
        })
        return res && res.length ? res[0].get() : false
    }

    async updateTrading ({ values }) {
        const res = await this.store.upsert(values, {
            where: {
                [Op.eq]: {
                    orderId: values.orderId
                }
            }
        })
        if (res && res.length && res[0] === 1) {
            return await this.findTradingByOrderId({ orderId: values.orderId })
        }
        return false
    }

    async removeTrading ({ tradingId }) {
        return await this.store.destroy({ where: { tradingId } })
    }
}

module.exports = CompletedTrade

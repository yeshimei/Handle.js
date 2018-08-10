import {getOp, getRequestData, mixinScope, getProxyFunNames} from './utils'
import Include from "./inclue"
import Base from './interface'
import {sequelize} from "../../models/as-venus"

/**
 * Handle.js，
 * 一个基于 koa 和 sequelize 的中间库,
 * 让你只专注于接口逻辑。
 *
 * @constructor
 * @param {Model} model - sequelize 的模型实例
 * @param {object} [options={}] - 选项对象
 * @param {Mock} [options.mock=null] - mock 库，以启用 Handle.prototype.mock 方法
 * @param {function} [options.before(data, ctx, next)] - 全局钩子。before 钩子在数据库操作之前执行。（注意，全局钩子 before 与快捷方法的 before 函数行为一致，但 before 函数在 全局钩子 before 之后调用，可能会发生覆盖。）
 * @param {function} [options.after(result, ctx, next)] - 全局钩子。 after 钩子在数据库操作之后执行（注意，情况和全局钩子 before 相同）
 * @param {function} [options.data(err, data, ctx, next)] - 全局钩子。data 钩子可以在返回数据到前端之前和捕获异常之后做一些处理。
 * @extends Base
 */
class Handle extends Base{
  constructor (model, options = {}) {
    super()
    this.model = model
    this.options = options
    // TODO: 方法作用域需要在恰当的时机清空，以保证其他方法不会受到干扰
    this._defaultScopes = []  // 存放实例作用域的容器
    this._scopes = []         // 存放方法作用域的容器
    this._data = {}           // 临时保存 request body data (过程方法的 HACK)

    this.__init(getProxyFunNames)
  }

  /**
   * 组合一个或多个实例作用域（作用于实例的每个方法）
   *
   * @since 1.0.0
   * @param {object|function} scopes - 作用域
   * @returns {Handle}
   * @see scope rawScope
   */
  defaultScope (...scopes) {
    scopes.forEach(scope => this._defaultScopes.push(scope))
    return this
  }

  /**
   * 组合一个或多个方法作用域（仅作用于接下来第一次使用的方法）
   *
   * @since 1.0.0
   * @param {object|function} scopes - 作用域
   * @returns {Handle}
   * @see defaultScope rawScope
   */
  scope (...scopes) {
    this._scopes = [] // TODO 清空实例作用域的代码，放这里只是用于测试
    scopes.forEach(scope => this._scopes.push(scope))
    return this
  }

  /**
   * 组合一个或多个 sequelize 作用域（一层简单的封装）
   *
   * @since 1.0.0
   * @param {object|function} scopeNames - 要组合的作用域名
   * @returns {Handle}
   * @see defaultScope scope
   */
  rawScope (...scopeNames) {
    return new Handle(this.model.scope(...scopeNames), this.options)
  }


  /**
   * 开始一个过程流程，并结合过程方法（raw*）提供更灵活的空间。
   * 过程的流程处在【获取前端数据】与【返回数据到前端】之间,
   * 过程方法（以 raw 开头的模型方法）专门为过程流程而生，
   * 它不同于快捷方法，过程方法返回从数据库来的数据，并由你决定如何处理。
   * 很合适数据验证、过滤和对数据库多次操作的场景。
   * 全局钩子的行为发生了一些变化，在整个过程流程中只会执行一次。
   * （注意，流程结束时，必须 return 出返回前端的数据）
   *
   * @since 1.0.0
   * @param {string} [method='get'] - 请求方法
   * @param {asyncFunction} f(data,ctx,next) - 一个 async/await 函数
   * @returns {Function}
   */
  process (method, f) {
    if (typeof method === 'function') {f = method; method = 'get'}

    const {
      before: globalBefore,
      after: globalAfter,
      data: globalData
    } = this.options



    return async (ctx, next) => {
      let data = getRequestData(method, ctx)
      try {
        globalBefore && globalBefore(data, ctx, next)

        // 过程方法内部需用 request body data 处理 where 处理子句简写和作用域
        this._data = data
        let result = await f.call(this, data, ctx, next)
        this._data = {}

        if (globalAfter) result = globalAfter(result, ctx, next)
        return ctx.body = globalData(undefined, result, ctx, next)
      } catch (err) {
        return ctx.body = globalData(err, null, ctx, next)
      }
    }
  }

  /**
   * TODO: 需重写
   */
  toggle (...args) {
    return this.process(async function (d) {
      const res = await this.rawFindOne(...args)
      return res
        ? this.rawDestroy(...args)
        : this.rawCreate()
    })
  }

  async rawToggle (...args) {
    const res = await this.rawFindOne(...args)
    console.log(res, args)
    return res
      ? this.rawDestroy(...args)
      : this.rawCreate()
  }

  /**
   * 启用一个事务，用法上和 process 相同。
   *
   * @since 1.0.0
   * @param {string} [method='get'] - 请求方法
   * @param {asyncFunction} f(data,ctx,next,t) - 一个 async/await 函数
   * @returns {Function}
   */
  transaction (method, f) {
    return this.process(method, async function (d, ctx, next) {
      return await sequelize.transaction(t => f.call(this, d, ctx, next, t))
    })
  }

  /**
   * 向数据库中批量插入由 mock 生成的随机数据
   *
   * @since 1.0.0
   * @category String
   * @param {object} rule - mock 的生成规则
   * @example
   *
   * // 生成 10 条数据（mockjs 为例）
   * h.mock({
   *  'data|10': [
   *    {
   *      title: '@ctitle',
   *      content: '@cparagraph',
   *    }
   *  ]
   * })
   *
   * @returns {*}
   */
  mock (rule) {
    const Mock = this.options.mock
    if (!Mock) throw new Error(
      'Handle.prototype.mock 方法依赖 mock 库，推荐使用 mockjs' +
      '\n npm install mockjs --save' +
      '\n 然后，在 Handle.options.mock = Mock 使用指定的 mock 库'
    )

    return this.bulkCreate({}, _ => Mock.mock(rule).data)
  }

  /**
   * 实例化时，批量生成两套方法（快捷方法和过程方法）
   *
   * @param {object} map
   * @private
   */
  __init (map) {
    for (let method in map) {
      map[method].forEach(funcName => {
        // 注意，绝逼不能用箭头函数，之前引起了模型引用错乱的 bug（mnp）
        Handle.prototype[funcName] = function (...args) {
          const scopes = this._scopes
          this._scopes = []
          return this.__base(method, funcName, scopes, ...args)
        }
        const rawFuncName = 'raw' + funcName[0].toUpperCase() + funcName.substring(1)
        Handle.prototype[rawFuncName] = function (...args) {
          const scopes = this._scopes
          this._scopes = []
          return this.__processBase(funcName, scopes, ...args)
        }
      })
    }
  }

  /**
   * 快捷方法的基本函数
   *
   * @param {string} method - http 请求方法
   * @param {string} funcName - sequelize 模型对象上的方法名
   * @param {string|Array|Function} - o 模型方法的选项
   * @param {Function} after - 局部钩子, 在全局钩子 after 之后调用（不推荐使用，请用过程流程代替）
   * @param {Function} before - 局部钩子，在全局钩子 before 之后调用（不推荐使用，请用过程流程代替）
   * @returns {*}
   * @private
   */

  __base (method, funcName, scopes, o, before, after) {
    const {
      before: globalBefore,
      after: globalAfter,
      data: globalData
    } = this.options

    return async (ctx, next) => {
      let data = getRequestData(method, ctx)
      try {
        if (globalBefore) data = globalBefore(data, ctx, next)
        if(before) data = before(data, ctx, next)
        // 生成模型方法的选项对象并混合作用域
        console.log('data ->', data)
        let op = getOp(o, data, ctx, next)
        op = mixinScope(data, op, this._defaultScopes, scopes)
        // 根据模型方法的参数个数生成对应的参数数据
        const func = this.model[funcName]
        let len = func.length
        op = len === 1 ? [op] : len === 2 ? [data, op] : []
        // 操作数据库
        let result = await func.apply(this.model, op)

        if (globalAfter) result = globalAfter(result, ctx, next)
        if (after) result = after(result, ctx, next)
        return ctx.body = globalData(undefined, result, ctx, next)
      } catch (err) {
        return ctx.body = globalData(err, null, ctx, next)
      }
    }
  }

  /**
   * 过程方法的基本方法
   *
   * @param {string} funcName - sequelize 模型对象上的方法名
   * @param {object} d - request body data
   * @param {string|Array|Function} - o 模型方法的选项
   * @returns {Promise<void>}
   * @private
   */
  async __processBase(funcName, scopes, o, d) {

    let data = this._data
    // 生成模型方法的选项对象并混合作用域
    let op = getOp(o, data)
    op = mixinScope(data, op, this._defaultScopes, scopes)
    // 根据...
    if (d) data = d
    const func = this.model[funcName]
    let len = func.length
    op = len === 1 ? [op] : len === 2 ? [data, op] : []
    return await this.model[funcName](...op)
    return await this.model[funcName](...op)
  }
}


/**
 * 关联生成器
 *
 * @since 1.0.0
 * @type {Include}
 * @see Include
 */
Handle.Include = new Include()


export default Handle
import {
  BigDecimal,
  BigInt,
  Bytes,
  dataSource,
  ethereum
} from '@graphprotocol/graph-ts'
import {
  Pool,
  User,
  PoolToken,
  PoolShare,
  PoolTransaction,
  PoolFactory,
  Datatoken,
  TokenBalance,
  TokenTransaction,
  PoolTransactionTokenValues
} from '../types/schema'
import { log } from '@graphprotocol/graph-ts'

export let ZERO_BD = BigDecimal.fromString('0.0')
export let MINUS_1 = BigDecimal.fromString('-1.0')
export let ONE = BigDecimal.fromString('1.0')

export let ENABLE_DEBUG = false

let network = dataSource.network()

export let OCEAN: string = (network == 'mainnet')
  ? '0x967da4048cd07ab37855c090aaf366e4ce1b9f48'
  : '0x8967BCF84170c91B0d24D4302C2376283b0B3a07'

export function debuglog(message: string, event: ethereum.Event, args: Array<string>): void {
  if (!ENABLE_DEBUG) return

  if (event != null) {
    args.push(event.transaction.hash.toHex())
    args.push(event.address.toHex())
  }
  for (let i=0; i < args.length; i++) {
    message = message.concat(' {}')
  }
  log.info(message, args)
}

export function hexToDecimal(hexString: String, decimals: i32): BigDecimal {
  let bytes = Bytes.fromHexString(hexString.toString()).reverse() as Bytes
  let bi = BigInt.fromUnsignedBytes(bytes)
  let scale = BigInt.fromI32(10).pow(decimals as u8).toBigDecimal()
  return bi.divDecimal(scale)
}

export function bigIntToDecimal(amount: BigInt, decimals: i32): BigDecimal {
  let scale = BigInt.fromI32(10).pow(decimals as u8).toBigDecimal()
  return amount.toBigDecimal().div(scale)
}

export function tokenToDecimal(amount: BigDecimal, decimals: i32): BigDecimal {
  let scale = BigInt.fromI32(10).pow(decimals as u8).toBigDecimal()
  return amount.div(scale)
}

export function updatePoolTokenBalance(poolToken: PoolToken, balance: BigDecimal, source: string): void {
  debuglog('updating poolToken balance (source, oldBalance, newBalance, poolId) ', null,
    [source, poolToken.balance.toString(), balance.toString(), poolToken.poolId])
  poolToken.balance = balance
}

export function createPoolShareEntity(id: string, pool: string, user: string): void {
  let poolShare = new PoolShare(id)

  createUserEntity(user)

  poolShare.userAddress = user
  poolShare.poolId = pool
  poolShare.balance = ZERO_BD
  poolShare.save()
}

export function createPoolTokenEntity(id: string, pool: string, address: string): void {
  let datatoken = Datatoken.load(address)

  let poolToken = new PoolToken(id)
  poolToken.poolId = pool
  poolToken.tokenId = datatoken ? datatoken.id: ''
  poolToken.tokenAddress = address
  poolToken.balance = ZERO_BD
  poolToken.denormWeight = ZERO_BD
  poolToken.save()
}

export function updatePoolTransactionToken(
  poolTx: string, poolTokenId: string, amount: BigDecimal,
  balance: BigDecimal, feeValue: BigDecimal
): void {

  let ptx = PoolTransaction.load(poolTx)
  let poolToken = PoolToken.load(poolTokenId)
  let ptxTokenValuesId = poolTx.concat('-').concat(poolToken.tokenAddress)
  let ptxTokenValues = PoolTransactionTokenValues.load(ptxTokenValuesId)
  if (ptxTokenValues == null) {
    ptxTokenValues = new PoolTransactionTokenValues(ptxTokenValuesId)
  }
  ptxTokenValues.txId = poolTx
  ptxTokenValues.poolToken = poolTokenId
  ptxTokenValues.poolAddress = poolToken.poolId
  ptxTokenValues.userAddress = ptx.userAddress
  ptxTokenValues.tokenAddress = PoolToken.load(poolTokenId).tokenAddress

  ptxTokenValues.value = amount
  ptxTokenValues.tokenReserve = balance
  ptxTokenValues.feeValue = feeValue
  if (amount.lt(ZERO_BD)) {
    ptxTokenValues.type = 'out'
  } else {
    ptxTokenValues.type = 'in'
  }

  ptxTokenValues.save()
}

export function createPoolTransaction(event: ethereum.Event, event_type: string, userAddress: string): void {
  let poolId = event.address.toHex()
  let pool = Pool.load(poolId)
  let ptx = event.transaction.hash.toHexString()

  let ocnToken = PoolToken.load(poolId.concat('-').concat(OCEAN))
  let dtToken = PoolToken.load(poolId.concat('-').concat(pool.datatokenAddress))

  if (ocnToken == null || dtToken == null) {
    return
  }

  let poolTx = PoolTransaction.load(ptx)
  if (poolTx != null) {
    return
  }
  poolTx = new PoolTransaction(ptx)

  poolTx.poolAddress = poolId
  poolTx.userAddress = userAddress
  poolTx.poolAddressStr = poolId
  poolTx.userAddressStr = userAddress

  poolTx.sharesTransferAmount = ZERO_BD
  poolTx.sharesBalance = ZERO_BD
  poolTx.spotPrice = calcSpotPrice(
    ocnToken.denormWeight, dtToken.denormWeight, ocnToken.balance, dtToken.balance, pool.swapFee)
  // poolTx.consumePrice = calcInGivenOut(
  //   ocnToken.denormWeight, dtToken.denormWeight, ocnToken.balance, dtToken.balance,
  //   ONE, pool.swapFee)

  pool.datatokenReserve = dtToken.balance
  pool.oceanReserve = ocnToken.balance
  pool.spotPrice = poolTx.spotPrice
  pool.save()
  debuglog('updated pool reserves (source, dtBalance, ocnBalance, dtReserve, ocnReserve): ',
    event,
    ['createPoolTransaction', dtToken.balance.toString(), ocnToken.balance.toString(),
      pool.datatokenReserve.toString(), pool.oceanReserve.toString()])
  // pool.consumePrice = ZERO_BD

  poolTx.tx = event.transaction.hash
  poolTx.event = event_type
  poolTx.block = event.block.number.toI32()
  poolTx.timestamp = event.block.timestamp.toI32()
  poolTx.gasUsed = event.transaction.gasUsed.toBigDecimal()
  poolTx.gasPrice = event.transaction.gasPrice.toBigDecimal()

  poolTx.save()
}

export function calcSpotPrice(
  wIn: BigDecimal, wOut: BigDecimal,
  balanceIn: BigDecimal, balanceOut: BigDecimal,
  swapFee: BigDecimal
): BigDecimal {
  let numer = balanceIn.div(wIn)
  let denom = balanceOut.div(wOut)
  let ratio = numer.div(denom)
  let scale = ONE.div(ONE.minus(swapFee))
  return  ratio.times(scale)
}

// export function calcInGivenOut(
//   wIn: BigDecimal, wOut: BigDecimal, balanceIn: BigDecimal, balanceOut: BigDecimal,
//   amountOut: BigDecimal, swapFee: BigDecimal): BigDecimal {
//
//   let weightRatio = wOut.div(wIn)
//   let diff = balanceOut.minus(amountOut)
//   let y = balanceOut.div(diff)
//   y.toString()
//
//   let foo = BigDecimal.fromString(Math.pow(y, weightRatio).toString()) - ONE
//   return balanceIn.times(foo / (ONE - swapFee))
// }


export function decrPoolCount(finalized: boolean): void {
  let factory = PoolFactory.load('1')
  factory.poolCount -= 1
  if (finalized) factory.finalizedPoolCount -= 1
  factory.save()
}

export function saveTokenTransaction(event: ethereum.Event, eventName: string): void {
  let tx = event.transaction.hash.toHexString().concat('-').concat(event.logIndex.toString())
  let userAddress = event.transaction.from.toHex()
  let transaction = TokenTransaction.load(tx)
  if (transaction == null) {
    transaction = new TokenTransaction(tx)
  }
  transaction.event = eventName
  transaction.datatokenAddress = event.address.toHex()
  transaction.userAddress = userAddress
  transaction.gasUsed = event.transaction.gasUsed.toBigDecimal()
  transaction.gasPrice = event.transaction.gasPrice.toBigDecimal()
  transaction.tx = event.transaction.hash
  transaction.timestamp = event.block.timestamp.toI32()
  transaction.block = event.block.number.toI32()
  transaction.save()

  createUserEntity(userAddress)
}

export function createUserEntity(address: string): void {
  if (User.load(address) == null) {
    let user = new User(address)
    user.save()
  }
}

export function updateTokenBalance(id: string, token: string, user: string, amount: BigDecimal): void {
  let tokenBalance = TokenBalance.load(id)
  if (tokenBalance == null) {
    tokenBalance = new TokenBalance(id)
    createUserEntity(user)
    tokenBalance.userAddress = user
    tokenBalance.datatokenId = token
    tokenBalance.balance = ZERO_BD
  }

  tokenBalance.balance = tokenBalance.balance.plus(amount)
  tokenBalance.save()
}

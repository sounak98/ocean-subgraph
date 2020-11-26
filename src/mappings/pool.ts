
import { BigInt, Address, Bytes, store, BigDecimal } from '@graphprotocol/graph-ts'
import { LOG_CALL, LOG_JOIN, LOG_EXIT, LOG_SWAP, Transfer } from '../types/templates/Pool/Pool'
import { Pool as BPool } from '../types/templates/Pool/Pool'
import { log } from '@graphprotocol/graph-ts'

import {
    OceanPools,
    Pool,
    PoolToken,
    PoolShare,
    Swap,
    TokenPrice, Datatoken
} from '../types/schema'
import {
  hexToDecimal,
  bigIntToDecimal,
  tokenToDecimal,
  createPoolShareEntity,
  createPoolTokenEntity,
  updatePoolLiquidity,
  savePoolTransaction,
  ZERO_BD,
  decrPoolCount
} from './helpers'

/************************************
 ********** Pool Controls ***********
 ************************************/

export function handleSetSwapFee(event: LOG_CALL, swapFeeStr: string=null): void {
  let poolId = event.address.toHex()
  let pool = Pool.load(poolId)
  if (!swapFeeStr) {
    swapFeeStr = event.params.data.toHexString().slice(-40)
  }
  pool.swapFee = hexToDecimal(swapFeeStr, 18)
  pool.save()

  // savePoolTransaction(event, 'setSwapFee')
}

export function handleSetController(event: LOG_CALL): void {
  let poolId = event.address.toHex()
  let pool = Pool.load(poolId)
  let controller = Address.fromString(event.params.data.toHexString().slice(-40))
  pool.controller = controller
  pool.save()

  // savePoolTransaction(event, 'setController')
}

export function handleSetPublicSwap(event: LOG_CALL): void {
  let poolId = event.address.toHex()
  let pool = Pool.load(poolId)
  pool.publicSwap = event.params.data.toHexString().slice(-1) == '1'
  pool.save()

  // savePoolTransaction(event, 'setPublicSwap')
}

export function handleFinalize(event: LOG_CALL): void {
  let poolId = event.address.toHex()
  let pool = Pool.load(poolId)
  // let balance = BigDecimal.fromString('100')
  pool.finalized = true
  pool.symbol = 'BPT'
  pool.publicSwap = true
  // pool.totalShares = balance
  pool.save()

  /*
  let poolShareId = poolId.concat('-').concat(event.params.caller.toHex())
  let poolShare = PoolShare.load(poolShareId)
  if (poolShare == null) {
    createPoolShareEntity(poolShareId, poolId, event.params.caller.toHex())
    poolShare = PoolShare.load(poolShareId)
  }
  poolShare.balance = balance
  poolShare.save()
  */

  let factory = OceanPools.load('1')
  factory.finalizedPoolCount = factory.finalizedPoolCount + 1
  factory.save()

  // savePoolTransaction(event, 'finalize')
}

export function handleSetup(event: LOG_CALL): void {
  let poolId = event.address.toHex()

  let data = event.params.data.toHexString()
  // First 2 chars are 0x
  // Next there is 8 chars
  // Next starts the data each params occupies exactly 64 chars
  // Each value is padded with 0s to the left
  // For an Address, need to remove the leading 24 zeros, because the address itself is 40 chars
  // For numbers we donot need to remove the leading zeros because they have no effect being on the left of the number

  // skip 8 then take the last 40 (2 + 8 + 24 = 34) to (2 + 8 + 64 = 74)
  let dataTokenAddress = Address.fromString(data.slice(34,74)).toHexString()

  let dataTokenAmount = data.slice(74, 138) // 74+64
  let dataTokenWeight = data.slice(138,202) // (74+64,74+(2*64)
  let baseTokenAddress = Address.fromString(data.slice(202+24, 266)).toHexString() // (74+(2*64)+24, 74+(3*64))
  let baseTokenAmount = data.slice(266,330) // (74+(3*64),74+(4*64))
  let baseTokenWeight = data.slice(330,394) // (74+(4*64),74+(5*64))
  let swapFee = data.slice(394) // (74+(5*64), END)
  // log.error('handleSetup: ##{}, {}, {}, {}, {}, {}, {}##, \nDATA=##{} ##\n lenData={}',
  //   [dataTokenAddress, dataTokenAmount, dataTokenWeight, baseTokenAddress, baseTokenAmount, baseTokenWeight, swapFee, data, BigInt.fromI32(data.length).toString()])

  _handleRebind(event, poolId, dataTokenAddress, dataTokenAmount, dataTokenWeight)
  _handleRebind(event, poolId, baseTokenAddress, baseTokenAmount, baseTokenWeight)
  handleSetSwapFee(event, swapFee)
  handleFinalize(event)
  savePoolTransaction(event, 'setup')
}

export function _handleRebind(event: LOG_CALL, poolId: string, tokenAddress: string, balanceStr: string, denormWeightStr: string): void {
  let pool = Pool.load(poolId)
  let decimals = BigInt.fromI32(18).toI32()

  let tokenBytes = Bytes.fromHexString(tokenAddress) as Bytes
  let tokensList = pool.tokensList || []
  if (tokensList.indexOf(tokenBytes) == -1 ) {
    tokensList.push(tokenBytes)
  }
  pool.tokensList = tokensList
  pool.tokensCount = BigInt.fromI32(tokensList.length)
  let address = Address.fromString(tokenAddress)
  let denormWeight = hexToDecimal(denormWeightStr, decimals)

  let poolTokenId = poolId.concat('-').concat(address.toHexString())
  let poolToken = PoolToken.load(poolTokenId)
  if (poolToken == null) {
    createPoolTokenEntity(poolTokenId, poolId, address.toHexString())
    poolToken = PoolToken.load(poolTokenId)
    pool.totalWeight += denormWeight
  } else {
    let oldWeight = poolToken.denormWeight
    if (denormWeight > oldWeight) {
      pool.totalWeight = pool.totalWeight + (denormWeight - oldWeight)
    } else {
      pool.totalWeight = pool.totalWeight - (oldWeight - denormWeight)
    }
  }


  let balance = hexToDecimal(balanceStr, decimals)
  poolToken.balance = balance
  poolToken.denormWeight = denormWeight
  poolToken.save()
  if (balance.equals(ZERO_BD)) {
    decrPoolCount(pool.finalized)
    pool.active = false
  }
  pool.save()

  updatePoolLiquidity(poolId)
}

export function handleRebind(event: LOG_CALL): void {
  let poolId = event.address.toHex()
  _handleRebind(
      event,
      poolId,
      event.params.data.toHexString().slice(34,74),
      event.params.data.toHexString().slice(74,138),
      event.params.data.toHexString().slice(138)
  )

  savePoolTransaction(event, 'rebind')

}

/************************************
 ********** JOINS & EXITS ***********
 ************************************/

export function handleJoinPool(event: LOG_JOIN): void {
  let poolId = event.address.toHex()

  let pool = Pool.load(poolId)
  pool.joinsCount = pool.joinsCount.plus(BigInt.fromI32(1))
  pool.save()

  let address = event.params.tokenIn.toHex()
  let poolTokenId = poolId.concat('-').concat(address.toString())
  let poolToken = PoolToken.load(poolTokenId)
  if (!poolToken) {
    return
  }

  let datatoken: Datatoken | null
  datatoken = poolToken.tokenId != null ? Datatoken.load(poolToken.tokenId) : null
  let decimals = datatoken == null ? BigInt.fromI32(18).toI32() : datatoken.decimals
  let tokenAmountIn = tokenToDecimal(event.params.tokenAmountIn.toBigDecimal(), decimals)
  poolToken.balance = poolToken.balance.plus(tokenAmountIn)
  poolToken.save()

  updatePoolLiquidity(poolId)
  savePoolTransaction(event, 'join')
}

export function handleExitPool(event: LOG_EXIT): void {
  let poolId = event.address.toHex()

  let address = event.params.tokenOut.toHex()
  let poolTokenId = poolId.concat('-').concat(address.toString())
  let poolToken = PoolToken.load(poolTokenId)
  if (!poolToken) {
    return
  }

  let datatoken: Datatoken | null
  datatoken = poolToken.tokenId != null ? Datatoken.load(poolToken.tokenId) : null
  let decimals = datatoken == null ? BigInt.fromI32(18).toI32() : datatoken.decimals
  let tokenAmountOut = tokenToDecimal(event.params.tokenAmountOut.toBigDecimal(), decimals)
  let newAmount = poolToken.balance.minus(tokenAmountOut)
  poolToken.balance = newAmount
  poolToken.save()

  let pool = Pool.load(poolId)
  pool.exitsCount = pool.exitsCount.plus(BigInt.fromI32(1))
  if (newAmount.equals(ZERO_BD)) {
    decrPoolCount(pool.finalized)
    pool.active = false
  }
  pool.save()

  updatePoolLiquidity(poolId)
  savePoolTransaction(event, 'exit')
}

/************************************
 ************** SWAPS ***************
 ************************************/

export function handleSwap(event: LOG_SWAP): void {
  let poolId = event.address.toHex()

  let tokenIn = event.params.tokenIn.toHex()
  let poolTokenInId = poolId.concat('-').concat(tokenIn.toString())
  let poolTokenIn = PoolToken.load(poolTokenInId)
  if (!poolTokenIn) {
    return
  }
  let dtIn = Datatoken.load(tokenIn)
  let tokenAmountIn = tokenToDecimal(event.params.tokenAmountIn.toBigDecimal(), (dtIn == null) ? 18 : dtIn.decimals)
  let newAmountIn = poolTokenIn.balance.plus(tokenAmountIn)
  poolTokenIn.balance = newAmountIn
  poolTokenIn.save()

  let tokenOut = event.params.tokenOut.toHex()
  let poolTokenOutId = poolId.concat('-').concat(tokenOut.toString())
  let poolTokenOut = PoolToken.load(poolTokenOutId)
  let dtOut = Datatoken.load(tokenOut)
  let tokenAmountOut = tokenToDecimal(event.params.tokenAmountOut.toBigDecimal(), (dtOut == null) ? 18 : dtOut.decimals)
  let newAmountOut = poolTokenOut.balance.minus(tokenAmountOut)
  poolTokenOut.balance = newAmountOut
  poolTokenOut.save()

  updatePoolLiquidity(poolId)

  let swapId = event.transaction.hash.toHexString().concat('-').concat(event.logIndex.toString())
  let swap = Swap.load(swapId)
  if (swap == null) {
    swap = new Swap(swapId)
  }

  let pool = Pool.load(poolId)
  let tokensList: Array<Bytes> = pool.tokensList
  let tokenOutPriceValue = ZERO_BD
  let tokenOutPrice = TokenPrice.load(tokenOut)

  if (tokenOutPrice != null) {
    tokenOutPriceValue = tokenOutPrice.price
  } else {
    for (let i: i32 = 0; i < tokensList.length; i++) {
      let tokenPriceId = tokensList[i].toHexString()
      if (!tokenOutPriceValue.gt(ZERO_BD) && tokenPriceId !== tokenOut) {
        let tokenPrice = TokenPrice.load(tokenPriceId)
        if (tokenPrice !== null && tokenPrice.price.gt(ZERO_BD)) {
          let poolTokenId = poolId.concat('-').concat(tokenPriceId)
          let poolToken = PoolToken.load(poolTokenId)
          tokenOutPriceValue = tokenPrice.price
            .times(poolToken.balance)
            .div(poolToken.denormWeight)
            .times(poolTokenOut.denormWeight)
            .div(poolTokenOut.balance)
        }
      }
    }
  }

  let totalSwapVolume = pool.totalSwapVolume
  let totalSwapFee = pool.totalSwapFee
  let liquidity = pool.liquidity
  let swapValue = ZERO_BD
  let swapFeeValue = ZERO_BD

  if (tokenOutPriceValue.gt(ZERO_BD)) {
    swapValue = tokenOutPriceValue.times(tokenAmountOut)
    swapFeeValue = swapValue.times(pool.swapFee)
    totalSwapVolume = totalSwapVolume.plus(swapValue)
    totalSwapFee = totalSwapFee.plus(swapFeeValue)

    let factory = OceanPools.load('1')
    factory.totalSwapVolume = factory.totalSwapVolume.plus(swapValue)
    factory.totalSwapFee = factory.totalSwapFee.plus(swapFeeValue)
    factory.save()

    pool.totalSwapVolume = totalSwapVolume
    pool.totalSwapFee = totalSwapFee
  }
  pool.swapsCount += BigInt.fromI32(1)
  if (newAmountIn.equals(ZERO_BD) || newAmountOut.equals(ZERO_BD)) {
    decrPoolCount(pool.finalized)
    pool.active = false
  }
  pool.save()

  swap.caller = event.params.caller
  swap.tokenIn = event.params.tokenIn
  swap.tokenInSym = (dtIn == null) ? 'OCEAN' : dtIn.symbol
  swap.tokenOut = event.params.tokenOut
  swap.tokenOutSym = (dtOut == null) ? 'OCEAN' : dtOut.symbol
  swap.tokenAmountIn = tokenAmountIn
  swap.tokenAmountOut = tokenAmountOut
  swap.poolAddress = event.address.toHex()
  swap.userAddress = event.transaction.from.toHex()
  swap.poolTotalSwapVolume = totalSwapVolume
  swap.poolTotalSwapFee = totalSwapFee
  swap.poolLiquidity = liquidity
  swap.value = swapValue
  swap.feeValue = swapFeeValue
  swap.timestamp = event.block.timestamp.toI32()
  swap.save()

  savePoolTransaction(event, 'swap')
}

/************************************
 *********** POOL SHARES ************
 ************************************/

 export function handleTransfer(event: Transfer): void {
  let poolId = event.address.toHex()

  let ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

  let isMint = event.params.from.toHex() == ZERO_ADDRESS
  let isBurn = event.params.to.toHex() == ZERO_ADDRESS

  let poolShareFromId = poolId.concat('-').concat(event.params.from.toHex())
  let poolShareFrom = PoolShare.load(poolShareFromId)
  let poolShareFromBalance = poolShareFrom == null ? ZERO_BD : poolShareFrom.balance

  let poolShareToId = poolId.concat('-').concat(event.params.to.toHex())
  let poolShareTo = PoolShare.load(poolShareToId)
  let poolShareToBalance = poolShareTo == null ? ZERO_BD : poolShareTo.balance

  let pool = Pool.load(poolId)

  if (isMint) {
    if (poolShareTo == null) {
      createPoolShareEntity(poolShareToId, poolId, event.params.to.toHex())
      poolShareTo = PoolShare.load(poolShareToId)
    }
    poolShareTo.balance += tokenToDecimal(event.params.value.toBigDecimal(), 18)
    poolShareTo.save()
    pool.totalShares += tokenToDecimal(event.params.value.toBigDecimal(), 18)
  } else if (isBurn) {
    if (poolShareFrom == null) {
    createPoolShareEntity(poolShareFromId, poolId, event.params.from.toHex())
    poolShareFrom = PoolShare.load(poolShareFromId)
  }
    poolShareFrom.balance -= tokenToDecimal(event.params.value.toBigDecimal(), 18)
    poolShareFrom.save()
    pool.totalShares -= tokenToDecimal(event.params.value.toBigDecimal(), 18)
  } else {
    if (poolShareTo == null) {
      createPoolShareEntity(poolShareToId, poolId, event.params.to.toHex())
      poolShareTo = PoolShare.load(poolShareToId)
    }
    poolShareTo.balance += tokenToDecimal(event.params.value.toBigDecimal(), 18)
    poolShareTo.save()

    if (poolShareFrom == null) {
      createPoolShareEntity(poolShareFromId, poolId, event.params.from.toHex())
      poolShareFrom = PoolShare.load(poolShareFromId)
    }
    poolShareFrom.balance -= tokenToDecimal(event.params.value.toBigDecimal(), 18)
    poolShareFrom.save()
  }

  if (
    poolShareTo !== null
    && poolShareTo.balance.notEqual(ZERO_BD)
    && poolShareToBalance.equals(ZERO_BD)
  ) {
    pool.holdersCount += BigInt.fromI32(1)
  }

  if (
    poolShareFrom !== null
    && poolShareFrom.balance.equals(ZERO_BD)
    && poolShareFromBalance.notEqual(ZERO_BD)
  ) {
    pool.holdersCount -= BigInt.fromI32(1)
  }

  pool.save()
}
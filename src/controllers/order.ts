import { and, asc, desc, eq, gt, gte, lte, ne, sql } from 'drizzle-orm';
import { ApiError } from '../lib/api-error';
import { asyncHandler } from '../lib/async-handler';
import { db } from '../lib/db';
import {
  marketTable,
  orderTable,
  stockHoldingTable,
  userTable,
  walletEventTable,
} from '../lib/db/schema';
import {
  createOrder as createOrderInput,
  updateOrder as updateOrderInput,
} from '../lib/validations/order';
import type { AuthenticatedRequest } from '../middlewares/verifyUser';

const createOrder = asyncHandler(async (req: AuthenticatedRequest, res) => {
  if (!req.user?.id) {
    throw new ApiError(401, 'User Not Authenticated!');
  }

  const validData = createOrderInput.safeParse(req.body);

  if (!validData.success) {
    throw new ApiError(400, validData.error.message);
  }

  const { marketId, amount, type, stockQuantity, outcome } = validData.data;
  const userId = req.user.id;

  if (
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    !Number.isSafeInteger(stockQuantity) ||
    stockQuantity <= 0 ||
    !Number.isSafeInteger(amount * stockQuantity)
  ) {
    throw new ApiError(400, 'Invalid Price or Stock Quantity!');
  }

  const result = await db.transaction(async (tx) => {
    const [market] = await tx
      .select({
        id: marketTable.id,
        title: marketTable.title,
        ownerId: marketTable.ownerId,
        amount: marketTable.amount,
        expiresAt: marketTable.expiresAt,
        resolved: marketTable.resolved,
        availableStocks: marketTable.avilabelStocks,
      })
      .from(marketTable)
      .where(eq(marketTable.id, marketId))
      .limit(1)
      .for('update');

    if (!market) {
      throw new ApiError(404, 'Market Not Found!');
    }

    const [user] = await tx
      .select({
        id: userTable.id,
        balance: userTable.balance,
      })
      .from(userTable)
      .where(eq(userTable.id, userId))
      .limit(1)
      .for('update');

    if (!user) {
      throw new ApiError(404, 'User Not Found!');
    }

    if (market.resolved !== 'pending') {
      throw new ApiError(400, 'Market Already Resolved!');
    }

    if (market.expiresAt <= new Date()) {
      throw new ApiError(400, 'Market Expired!');
    }

    if (type === 'bid' && user.balance < amount * stockQuantity) {
      throw new ApiError(400, 'Not Enough Balance!');
    }

    const debitBalance = async (debitAmount: number) => {
      if (debitAmount <= 0) return;

      if (!Number.isSafeInteger(debitAmount)) {
        throw new ApiError(400, 'Invalid Transaction Amount!');
      }

      const [updated] = await tx
        .update(userTable)
        .set({
          balance: sql`${userTable.balance} - ${debitAmount}`,
        })
        .where(and(eq(userTable.id, userId), gte(userTable.balance, debitAmount)))
        .returning({ id: userTable.id });

      if (!updated) {
        throw new ApiError(400, 'Not Enough Balance!');
      }
    };

    const creditBalance = async (targetUserId: string, creditAmount: number) => {
      if (creditAmount <= 0) return;

      if (!Number.isSafeInteger(creditAmount)) {
        throw new ApiError(400, 'Invalid Transaction Amount!');
      }

      const [updated] = await tx
        .update(userTable)
        .set({
          balance: sql`${userTable.balance} + ${creditAmount}`,
        })
        .where(eq(userTable.id, targetUserId))
        .returning({ id: userTable.id });

      if (!updated) {
        throw new ApiError(404, 'User Not Found!');
      }
    };

    // Add stocks to a user's holdings.
    const addHolding = async (targetUserId: string, quantity: number, outcome: 'yes' | 'no') => {
      if (quantity <= 0) return;

      await tx
        .insert(stockHoldingTable)
        .values({
          userId: targetUserId,
          marketId,
          quantity,
          outcome,
        })
        .onConflictDoUpdate({
          target: [stockHoldingTable.userId, stockHoldingTable.marketId],
          set: {
            quantity: sql`${stockHoldingTable.quantity} + ${quantity}`,
          },
        });
    };

    // Reserve stocks from the current user's holdings.
    const reserveHolding = async (quantity: number) => {
      const [holding] = await tx
        .update(stockHoldingTable)
        .set({
          quantity: sql`${stockHoldingTable.quantity} - ${quantity}`,
        })
        .where(
          and(
            eq(stockHoldingTable.userId, userId),
            eq(stockHoldingTable.marketId, marketId),
            gte(stockHoldingTable.quantity, quantity)
          )
        )
        .returning({
          quantity: stockHoldingTable.quantity,
        });

      if (!holding) {
        throw new ApiError(400, 'Not Enough Stocks!');
      }
    };

    const createWalletEvent = async (
      targetUserId: string,
      eventAmount: number,
      metadata: Record<string, unknown>
    ) => {
      if (eventAmount <= 0) return;

      await tx.insert(walletEventTable).values({
        userId: targetUserId,
        amount: eventAmount,
        metadata,
      });
    };

    // They are removed from available holdings immediately
    if (type === 'ask') {
      await reserveHolding(stockQuantity);
    }

    const oppositeType = type === 'bid' ? 'ask' : 'bid';

    const priceCondition =
      type === 'bid' ? lte(orderTable.amount, amount) : gte(orderTable.amount, amount);

    const oldOrders = await tx
      .select({
        id: orderTable.id,
        userId: orderTable.userId,
        amount: orderTable.amount,
        type: orderTable.type,
        remainingStocks: orderTable.remainingStocks,
      })
      .from(orderTable)
      .where(
        and(
          ne(orderTable.userId, userId),
          eq(orderTable.marketId, marketId),
          eq(orderTable.type, oppositeType),
          eq(orderTable.isCompleted, false),
          gt(orderTable.remainingStocks, 0),
          priceCondition
        )
      )
      .orderBy(
        type === 'bid' ? asc(orderTable.amount) : desc(orderTable.amount),
        asc(orderTable.createdAt)
      )
      .for('update');

    // 7. Execute matching.
    let remainingStocks = stockQuantity;
    let totalMatchedStocks = 0;

    for (const oldOrder of oldOrders) {
      if (remainingStocks <= 0) break;

      const matchedStocks = Math.min(remainingStocks, oldOrder.remainingStocks);

      const tradeAmount = matchedStocks * oldOrder.amount;

      if (!Number.isSafeInteger(tradeAmount)) {
        throw new ApiError(400, 'Invalid Trade Amount!');
      }

      const newRemainingStocks = oldOrder.remainingStocks - matchedStocks;

      await tx
        .update(orderTable)
        .set({
          remainingStocks: newRemainingStocks,
          isCompleted: newRemainingStocks === 0,
        })
        .where(eq(orderTable.id, oldOrder.id));

      if (type === 'bid') {
        // Incoming user is BUYER.
        // Existing order owner is SELLER

        // Buyer pays
        await debitBalance(tradeAmount);

        // Seller receives money
        await creditBalance(oldOrder.userId, tradeAmount);

        // Buyer receives stocks
        await addHolding(userId, matchedStocks, outcome);

        // Wallet events
        await createWalletEvent(userId, tradeAmount, {
          type: 'debit',
          marketId,
          orderId: oldOrder.id,
          title: 'Bought Stocks',
          quantity: matchedStocks,
        });

        await createWalletEvent(oldOrder.userId, tradeAmount, {
          type: 'credit',
          marketId,
          orderId: oldOrder.id,
          title: 'Sold Stocks',
          quantity: matchedStocks,
        });
      } else {
        // Incoming user is SELLER.
        // Existing order owner is BUYER.
        // Existing bid funds were reserved previously.

        // Seller receives money.
        await creditBalance(userId, tradeAmount);

        // Existing buyer receives stocks.
        await addHolding(oldOrder.userId, matchedStocks, outcome);

        // Wallet event.
        await createWalletEvent(userId, tradeAmount, {
          type: 'credit',
          marketId,
          orderId: oldOrder.id,
          title: 'Sold Stocks',
          quantity: matchedStocks,
        });
      }

      remainingStocks -= matchedStocks;
      totalMatchedStocks += matchedStocks;
    }

    //  Bid fallback: purchase from market inventory
    let marketFilledStocks = 0;

    if (
      type === 'bid' &&
      remainingStocks > 0 &&
      market.availableStocks > 0 &&
      amount >= market.amount &&
      market.ownerId !== userId
    ) {
      marketFilledStocks = Math.min(remainingStocks, market.availableStocks);

      const purchaseAmount = market.amount * marketFilledStocks;

      if (!Number.isSafeInteger(purchaseAmount)) {
        throw new ApiError(400, 'Invalid Purchase Amount!');
      }

      // Buyer pays
      await debitBalance(purchaseAmount);

      // Market owner receives money
      await creditBalance(market.ownerId, purchaseAmount);

      // Update inventory
      await tx
        .update(marketTable)
        .set({
          avilabelStocks: market.availableStocks - marketFilledStocks,
        })
        .where(eq(marketTable.id, marketId));

      // Buyer receives stocks
      await addHolding(userId, marketFilledStocks, outcome);

      // Wallet events
      await createWalletEvent(userId, purchaseAmount, {
        type: 'debit',
        marketId,
        title: 'Bought Market Stocks',
        quantity: marketFilledStocks,
      });

      await createWalletEvent(market.ownerId, purchaseAmount, {
        type: 'credit',
        marketId,
        title: 'Sold Market Stocks',
        quantity: marketFilledStocks,
      });

      remainingStocks -= marketFilledStocks;
    }

    //  Reserve funds for unmatched bid quantity
    if (type === 'bid' && remainingStocks > 0) {
      const reservedAmount = amount * remainingStocks;

      if (!Number.isSafeInteger(reservedAmount)) {
        throw new ApiError(400, 'Invalid Reservation Amount!');
      }

      await debitBalance(reservedAmount);

      await createWalletEvent(userId, reservedAmount, {
        type: 'debit',
        marketId,
        title: 'Reserved Funds For Bid',
        quantity: remainingStocks,
        price: amount,
      });
    }

    //  Create incoming order
    const [newOrder] = await tx
      .insert(orderTable)
      .values({
        userId,
        marketId,
        amount,
        type,
        stockQuantity,
        remainingStocks,
        outcome,
        isCompleted: remainingStocks === 0,
      })
      .returning({
        id: orderTable.id,
        stockQuantity: orderTable.stockQuantity,
        remainingStocks: orderTable.remainingStocks,
      });

    if (!newOrder) {
      throw new ApiError(500, 'Failed To Create Order!');
    }

    return {
      ...newOrder,
      matchedStocks: totalMatchedStocks,
      marketFilledStocks,
    };
  });

  res.status(201).json({
    success: true,
    message: 'Order Created Successfully',
    order: result,
  });
});

const updateOrder = asyncHandler(async (req: AuthenticatedRequest, res) => {
  if (!req.user?.id) {
    throw new ApiError(401, 'User Not Authenticated!');
  }

  const orderId = req.params.orderId as string;

  if (!orderId) {
    throw new ApiError(400, 'Order ID is required!');
  }

  const validData = updateOrderInput.safeParse(req.body);

  if (!validData.success) {
    throw new ApiError(400, validData.error.message);
  }

  const { amount, stockQuantity } = validData.data;
  const userId = req.user.id;

  if (
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    !Number.isSafeInteger(stockQuantity) ||
    stockQuantity <= 0
  ) {
    throw new ApiError(400, 'Invalid Price or Stock Quantity!');
  }

  // Get market ID before starting transaction.
  const [snapshot] = await db
    .select({
      marketId: orderTable.marketId,
    })
    .from(orderTable)
    .where(eq(orderTable.id, orderId))
    .limit(1);

  if (!snapshot) {
    throw new ApiError(404, 'Order Not Found!');
  }

  const result = await db.transaction(async (tx) => {
    const [market] = await tx
      .select({
        id: marketTable.id,
        resolved: marketTable.resolved,
        expiresAt: marketTable.expiresAt,
      })
      .from(marketTable)
      .where(eq(marketTable.id, snapshot.marketId))
      .limit(1)
      .for('update');

    if (!market) {
      throw new ApiError(404, 'Market Not Found!');
    }

    const [user] = await tx
      .select({
        id: userTable.id,
        balance: userTable.balance,
      })
      .from(userTable)
      .where(eq(userTable.id, userId))
      .limit(1)
      .for('update');

    if (!user) {
      throw new ApiError(404, 'User Not Found!');
    }

    const [order] = await tx
      .select({
        id: orderTable.id,
        userId: orderTable.userId,
        marketId: orderTable.marketId,
        amount: orderTable.amount,
        type: orderTable.type,
        stockQuantity: orderTable.stockQuantity,
        remainingStocks: orderTable.remainingStocks,
        isCompleted: orderTable.isCompleted,
      })
      .from(orderTable)
      .where(eq(orderTable.id, orderId))
      .limit(1)
      .for('update');

    if (!order) {
      throw new ApiError(404, 'Order Not Found!');
    }

    if (order.userId !== userId) {
      throw new ApiError(403, 'You Are Not The Owner Of This Order!');
    }

    if (order.marketId !== market.id) {
      throw new ApiError(400, 'Invalid Order Market!');
    }

    if (order.isCompleted || order.remainingStocks <= 0) {
      throw new ApiError(400, 'Order Already Completed!');
    }

    if (market.resolved !== 'pending') {
      throw new ApiError(400, 'Market Already Resolved!');
    }

    if (market.expiresAt <= new Date()) {
      throw new ApiError(400, 'Market Expired!');
    }

    const filledStocks = order.stockQuantity - order.remainingStocks;

    // Never allow modification of already executed quantity.
    if (stockQuantity <= filledStocks) {
      throw new ApiError(400, 'New Quantity Must Be Greater Than Already Filled Quantity!');
    }

    const newRemainingStocks = stockQuantity - filledStocks;

    //  Handle BID reservation.
    if (order.type === 'bid') {
      const oldReservedAmount = order.amount * order.remainingStocks;

      const newReservedAmount = amount * newRemainingStocks;

      if (!Number.isSafeInteger(oldReservedAmount) || !Number.isSafeInteger(newReservedAmount)) {
        throw new ApiError(400, 'Invalid Reservation Amount!');
      }

      // Positive = release funds.
      // Negative = reserve additional funds.
      const balanceDifference = oldReservedAmount - newReservedAmount;

      if (balanceDifference !== 0) {
        const [updatedUser] = await tx
          .update(userTable)
          .set({
            balance: sql`${userTable.balance} + ${balanceDifference}`,
          })
          .where(
            and(eq(userTable.id, userId), gte(sql`${userTable.balance} + ${balanceDifference}`, 0))
          )
          .returning({ id: userTable.id });

        if (!updatedUser) {
          throw new ApiError(400, 'Not Enough Balance!');
        }

        // Record reservation adjustment
        await tx.insert(walletEventTable).values({
          userId,
          amount: Math.abs(balanceDifference),
          metadata: {
            type: balanceDifference > 0 ? 'credit' : 'debit',
            marketId: market.id,
            orderId,
            title:
              balanceDifference > 0 ? 'Released Bid Reservation' : 'Additional Bid Reservation',
          },
        });
      }
    }

    //  Handle ASK stock reservation
    if (order.type === 'ask') {
      const stockDifference = order.remainingStocks - newRemainingStocks;

      if (stockDifference !== 0) {
        const [holding] = await tx
          .select({
            id: stockHoldingTable.id,
            quantity: stockHoldingTable.quantity,
          })
          .from(stockHoldingTable)
          .where(
            and(eq(stockHoldingTable.userId, userId), eq(stockHoldingTable.marketId, market.id))
          )
          .limit(1)
          .for('update');

        if (stockDifference < 0) {
          // Need additional stocks for the increased ask
          const additionalStocks = Math.abs(stockDifference);

          if (!holding || holding.quantity < additionalStocks) {
            throw new ApiError(400, 'Not Enough Stocks!');
          }

          await tx
            .update(stockHoldingTable)
            .set({
              quantity: sql`${stockHoldingTable.quantity} - ${additionalStocks}`,
            })
            .where(eq(stockHoldingTable.id, holding.id));
        } else {
          // Release previously reserved stocks
          if (holding) {
            await tx
              .update(stockHoldingTable)
              .set({
                quantity: sql`${stockHoldingTable.quantity} + ${stockDifference}`,
              })
              .where(eq(stockHoldingTable.id, holding.id));
          } else {
            // await tx
            //   .insert(stockHoldingTable)
            //   .values({
            //     userId,
            //     marketId: market.id,
            //     quantity: stockDifference,
            //   });
          }
        }
      }
    }

    const [updatedOrder] = await tx
      .update(orderTable)
      .set({
        amount,
        stockQuantity,
        remainingStocks: newRemainingStocks,
      })
      .where(eq(orderTable.id, orderId))
      .returning({
        id: orderTable.id,
        amount: orderTable.amount,
        type: orderTable.type,
        stockQuantity: orderTable.stockQuantity,
        remainingStocks: orderTable.remainingStocks,
      });

    if (!updatedOrder) {
      throw new ApiError(500, 'Failed To Update Order!');
    }

    return updatedOrder;
  });

  res.status(200).json({
    success: true,
    message: 'Order Updated Successfully',
    order: result,
  });
});

const deleteOrder = asyncHandler(async (req: AuthenticatedRequest, res) => {
  if (!req.user?.id) {
    throw new ApiError(401, 'User Not Authenticated!');
  }

  const orderId = req.params.orderId as string;

  if (!orderId) {
    throw new ApiError(400, 'Order ID is required!');
  }

  const deletedOrder = await db.transaction(async (tx) => {
    // Get market ID to establish consistent lock order.
    const [initialOrder] = await tx
      .select({ marketId: orderTable.marketId })
      .from(orderTable)
      .where(eq(orderTable.id, orderId))
      .limit(1);

    if (!initialOrder) {
      throw new ApiError(404, 'Order Not Found!');
    }

    const [market] = await tx
      .select({ id: marketTable.id })
      .from(marketTable)
      .where(eq(marketTable.id, initialOrder.marketId))
      .for('update');

    if (!market) {
      throw new ApiError(404, 'Market Not Found!');
    }

    const [user] = await tx
      .select({ id: userTable.id })
      .from(userTable)
      .where(eq(userTable.id, req.user!.id))
      .for('update');

    if (!user) {
      throw new ApiError(404, 'User Not Found!');
    }

    const [order] = await tx
      .select()
      .from(orderTable)
      .where(eq(orderTable.id, orderId))
      .for('update');

    if (!order) {
      throw new ApiError(404, 'Order Not Found!');
    }

    if (order.userId !== req.user!.id) {
      throw new ApiError(403, 'You Are Not The Owner Of This Order!');
    }

    if (order.isCompleted || order.remainingStocks <= 0) {
      throw new ApiError(400, 'Order Is Already Completed!');
    }

    const reservedStocks = order.remainingStocks;

    if (order.type === 'bid') {
      // Release remaining reserved bid funds.
      const refundAmount = order.amount * reservedStocks;

      if (!Number.isSafeInteger(refundAmount)) {
        throw new ApiError(400, 'Invalid Refund Amount!');
      }

      await tx
        .update(userTable)
        .set({
          balance: sql`${userTable.balance} + ${refundAmount}`,
        })
        .where(eq(userTable.id, order.userId));

      await tx.insert(walletEventTable).values({
        userId: order.userId,
        amount: refundAmount,
        metadata: {
          type: 'credit',
          title: 'Bid Order Cancellation Refund',
          orderId: order.id,
          marketId: order.marketId,
          reservedStocks,
        },
      });
    } else {
      // Release remaining reserved ask stocks.
      const [holding] = await tx
        .select({
          id: stockHoldingTable.id,
        })
        .from(stockHoldingTable)
        .where(
          and(
            eq(stockHoldingTable.userId, order.userId),
            eq(stockHoldingTable.marketId, order.marketId)
          )
        )
        .for('update');

      if (holding) {
        await tx
          .update(stockHoldingTable)
          .set({
            quantity: sql`${stockHoldingTable.quantity} + ${reservedStocks}`,
          })
          .where(eq(stockHoldingTable.id, holding.id));
      } else {
        // await tx
        //   .insert(stockHoldingTable)
        //   .values({
        //     userId: order.userId,
        //     marketId: order.marketId,
        //     quantity: reservedStocks,
        //   });
      }
    }

    await tx.delete(orderTable).where(eq(orderTable.id, order.id));

    return order;
  });

  res.status(200).json({
    success: true,
    message: 'Order Deleted Successfully',
    deletedOrderId: deletedOrder.id,
  });
});

const getOrdersByMarketId = asyncHandler(async (req: AuthenticatedRequest, res) => {
  if (!req.user || !req.user.id) {
    throw new ApiError(401, 'User Not Authenticated!');
  }

  const marketId = req.params.marketId as string;
  if (!marketId) {
    throw new ApiError(400, 'Market ID is required!');
  }

  const orders = await db
    .select({
      id: orderTable.id,
      userId: orderTable.userId,
      amount: orderTable.amount,
      type: orderTable.type,
      stockQuantity: orderTable.stockQuantity,
      remainingStocks: orderTable.remainingStocks,
      isCompleted: orderTable.isCompleted,
    })
    .from(orderTable)
    .where(eq(orderTable.marketId, marketId));

  res.status(200).json({
    success: true,
    message: 'Orders Fetched Successfully',
    orders,
  });
});

const getOrdersByUserId = asyncHandler(async (req: AuthenticatedRequest, res) => {
  if (!req.user || !req.user.id) {
    throw new ApiError(401, 'User Not Authenticated!');
  }

  const orders = await db
    .select({
      id: orderTable.id,
      marketId: orderTable.marketId,
      amount: orderTable.amount,
      type: orderTable.type,
      stockQuantity: orderTable.stockQuantity,
      remainingStocks: orderTable.remainingStocks,
      isCompleted: orderTable.isCompleted,
    })
    .from(orderTable)
    .where(eq(orderTable.userId, req.user.id));

  res.status(200).json({
    success: true,
    message: 'Orders Fetched Successfully',
    orders,
  });
});

export const orderController = {
  createOrder,
  updateOrder,
  deleteOrder,
  getOrdersByMarketId,
  getOrdersByUserId,
};

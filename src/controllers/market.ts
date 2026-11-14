import { and, asc, desc, eq, gt, gte, ilike, or, sql } from 'drizzle-orm';
import { asyncHandler } from '../lib/async-handler';
import { db } from '../lib/db';
import {
  marketTable,
  orderTable,
  stockHoldingTable,
  userTable,
  walletEventTable,
} from '../lib/db/schema';
import { createMarketInput, resolveMarketInput, splitInput } from '../lib/validations/market';
import { ApiError } from '../lib/api-error';
import type { AuthenticatedRequest } from '../middlewares/verifyUser';

const createMarket = asyncHandler(async (req: AuthenticatedRequest, res) => {
  if (!req.user || !req.user.id) {
    throw new ApiError(401, 'User Not Authenticated!');
  }

  const bodyData = req.body;

  const validData = createMarketInput.safeParse(bodyData);
  if (!validData.success) {
    throw new ApiError(400, validData.error.message);
  }

  const { title, description, expiresAt } = validData.data;

  const markets = await db
    .select({
      id: marketTable.id,
    })
    .from(marketTable)
    .where(and(eq(marketTable.ownerId, req.user.id), eq(marketTable.title, title)))
    .limit(1);

  if (markets.length > 0) {
    throw new ApiError(409, 'You Already Have A Market With This Title!');
  }

  const newMarkets = await db
    .insert(marketTable)
    .values({
      title,
      description,
      ownerId: req.user.id,
      expiresAt,
    })
    .returning({
      id: marketTable.id,
    });

  if (newMarkets.length === 0 || !newMarkets[0]) {
    throw new ApiError(500, 'Market Not Created!');
  }
  res.status(201).json({
    success: true,
    message: 'Market Created Successfully',
    market: {
      ...newMarkets[0],
      ...validData.data,
      ownerId: req.user.id,
    },
  });
});

const deleteMarket = asyncHandler(async (req: AuthenticatedRequest, res) => {
  if (!req.user || !req.user.id) {
    throw new ApiError(401, 'User Not Authenticated!');
  }

  const marketId = req.params.marketId as string;
  if (!marketId) {
    throw new ApiError(400, 'Market ID is required!');
  }

  const market = await db
    .select({
      id: marketTable.id,
      ownerId: marketTable.ownerId,
      resolved: marketTable.resolved,
      amount: marketTable.amount,
      availableStocks: marketTable.availableStocks,
      expiresAt: marketTable.expiresAt,
    })
    .from(marketTable)
    .where(eq(marketTable.id, marketId))
    .limit(1);

  if (market.length === 0 || !market[0]) {
    throw new ApiError(404, 'Market Not Found!');
  }

  if (market[0].ownerId !== req.user.id) {
    throw new ApiError(403, 'You Are Not The Owner Of This Market!');
  }

  if (market[0].resolved !== 'pending') {
    throw new ApiError(400, 'Market Already Resolved!');
  }

  if (market[0].availableStocks > 0) {
    throw new ApiError(400, 'Market Still Has Available Stocks!');
  }

  if (market[0].expiresAt <= new Date()) {
    throw new ApiError(400, 'Market Expired!');
  }

  await db.delete(marketTable).where(eq(marketTable.id, marketId));

  res.status(200).json({
    success: true,
    message: 'Market Deleted Successfully',
    id: marketId,
  });
});

const getMarkets = asyncHandler(async (req, res) => {
  const { query = '', page = '1', limit = '10', sort = 'createdAt', order = 'asc' } = req.query;

  const pageNumber = Math.max(1, Number(page));
  const limitNumber = Math.min(100, Math.max(1, Number(limit)));

  // Whitelist sortable columns
  const sortColumns = {
    createdAt: marketTable.createdAt,
    updatedAt: marketTable.updatedAt,
    title: marketTable.title,
    amount: marketTable.amount,
    expiresAt: marketTable.expiresAt,
    issuedStocks: marketTable.issuedStocks,
  };

  const sortColumn = sortColumns[sort as keyof typeof sortColumns] ?? marketTable.createdAt;

  const sortOrder = order === 'desc' ? desc : asc;

  const searchQuery = String(query).trim();

  const conditions = searchQuery
    ? or(
        ilike(marketTable.title, `%${searchQuery}%`),
        ilike(marketTable.description, `%${searchQuery}%`)
      )
    : undefined;

  const markets = await db
    .select({
      id: marketTable.id,
      title: marketTable.title,
      description: marketTable.description,
      ownerId: marketTable.ownerId,
      amount: marketTable.amount,
      issuedStocks: marketTable.issuedStocks,
      expiresAt: marketTable.expiresAt,
      createdAt: marketTable.createdAt,
      updatedAt: marketTable.updatedAt,
    })
    .from(marketTable)
    .where(conditions)
    .orderBy(sortOrder(sortColumn))
    .limit(limitNumber)
    .offset((pageNumber - 1) * limitNumber);

  res.status(200).json({
    success: true,
    pagination: {
      page: pageNumber,
      limit: limitNumber,
      count: markets.length,
    },
    markets,
  });
});

const split = asyncHandler(async (req: AuthenticatedRequest, res) => {
  if (!req.user?.id) {
    throw new ApiError(401, 'User Not Authenticated!');
  }

  const marketId = req.params.marketId as string;
  if (!marketId) {
    throw new ApiError(400, 'Market ID is required!');
  }

  const validData = splitInput.safeParse(req.body);

  if (!validData.success) {
    throw new ApiError(400, validData.error.message);
  }

  // Number of complete YES + NO sets.
  const quantity = validData.data.amount;

  // 1 complete set = ₹1.
  const collateral = quantity;
  const totalStocks = quantity * 2;

  const result = await db.transaction(async (tx) => {
    // 1. Lock market.
    const [market] = await tx
      .select()
      .from(marketTable)
      .where(eq(marketTable.id, marketId))
      .for('update');

    if (!market) {
      throw new ApiError(404, 'Market Not Found!');
    }

    if (market.resolved !== 'pending') {
      throw new ApiError(400, 'Market Already Resolved!');
    }

    if (market.expiresAt <= new Date()) {
      throw new ApiError(400, 'Market Expired!');
    }

    // 2. Atomically deduct collateral from user.
    const [user] = await tx
      .update(userTable)
      .set({
        balance: sql`${userTable.balance} - ${collateral}`,
        lockedBalance: sql`${userTable.lockedBalance} + ${collateral}`,
      })
      .where(and(eq(userTable.id, req.user!.id), gte(userTable.balance, collateral)))
      .returning({
        id: userTable.id,
        balance: userTable.balance,
      });

    if (!user) {
      throw new ApiError(400, 'Insufficient Balance or User Not Found!');
    }

    // 3. Increase market stock supply.
    const [updatedMarket] = await tx
      .update(marketTable)
      .set({
        amount: sql`${marketTable.amount} + ${collateral}`,
        issuedStocks: sql`${marketTable.issuedStocks} + ${totalStocks}`,
        availableStocks: sql`${marketTable.availableStocks} + ${totalStocks}`,
        updatedAt: new Date(),
      })
      .where(eq(marketTable.id, marketId))
      .returning();

    if (!updatedMarket) {
      throw new ApiError(500, 'Failed To Update Market!');
    }

    // 4. Create or update YES holdings.
    await tx
      .insert(stockHoldingTable)
      .values({
        userId: user.id,
        marketId,
        quantity,
        outcome: 'yes',
      })
      .onConflictDoUpdate({
        target: [stockHoldingTable.userId, stockHoldingTable.marketId, stockHoldingTable.outcome],
        set: {
          quantity: sql`${stockHoldingTable.quantity} + ${quantity}`,
          updatedAt: new Date(),
        },
      });

    // 5. Create or update NO holdings.
    await tx
      .insert(stockHoldingTable)
      .values({
        userId: user.id,
        marketId,
        quantity,
        outcome: 'no',
      })
      .onConflictDoUpdate({
        target: [stockHoldingTable.userId, stockHoldingTable.marketId, stockHoldingTable.outcome],
        set: {
          quantity: sql`${stockHoldingTable.quantity} + ${quantity}`,
          updatedAt: new Date(),
        },
      });

    // 6. Record collateral debit.
    await tx.insert(walletEventTable).values({
      userId: user.id,
      amount: collateral,
      type: 'debit',
      metadata: {
        title: 'Market Split',
        marketId,
        quantity,
        yesShares: quantity,
        noShares: quantity,
      },
    });

    return {
      marketId,
      quantity,
      collateral,
      yesShares: quantity,
      noShares: quantity,
      totalStocks,
      remainingBalance: user.balance,
    };
  });

  res.status(200).json({
    success: true,
    message: 'Market split successfully!',
    data: result,
  });
});

const resolveMarketController = asyncHandler(async (req: AuthenticatedRequest, res) => {
  if (!req.user?.id) {
    throw new ApiError(401, 'User Not Authenticated!');
  }

  const marketId = req.params.marketId as string;
  if (!marketId) {
    throw new ApiError(400, 'Market ID is required!');
  }

  const parsed = resolveMarketInput.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, parsed.error.message);
  }

  const { resolved, verifiedLink } = parsed.data;

  const result = await db.transaction(async (tx) => {
    const [market] = await tx
      .select()
      .from(marketTable)
      .where(eq(marketTable.id, marketId))
      .for('update');

    if (!market) {
      throw new ApiError(404, 'Market Not Found!');
    }

    if (market.resolved !== 'pending') {
      throw new ApiError(400, 'Market Already Resolved!');
    }

    const [admin] = await tx
      .select({
        id: userTable.id,
        role: userTable.role,
      })
      .from(userTable)
      .where(eq(userTable.id, req.user!.id))
      .limit(1);

    if (!admin) {
      throw new ApiError(404, 'User Not Found!');
    }

    if (admin.role !== 'admin') {
      throw new ApiError(403, 'Only admins can resolve markets!');
    }

    //  Lock all pending orders.
    const pendingOrders = await tx
      .select()
      .from(orderTable)
      .where(
        and(
          eq(orderTable.marketId, marketId),
          eq(orderTable.isCompleted, false),
          gt(orderTable.remainingStocks, 0)
        )
      )
      .for('update');

    let totalRefunded = 0;
    let totalReturnedStocks = 0;

    //  Cancel pending orders and release reservations
    for (const order of pendingOrders) {
      const remaining = order.remainingStocks;

      if (order.type === 'bid') {
        // Refund reserved bid money.
        const refund = order.amount * remaining;

        if (!Number.isSafeInteger(refund) || refund < 0) {
          throw new ApiError(400, 'Invalid Bid Refund Amount!');
        }

        if (refund > 0) {
          const [refundedUser] = await tx
            .update(userTable)
            .set({
              balance: sql`${userTable.balance} + ${refund}`,
            })
            .where(eq(userTable.id, order.userId))
            .returning({ id: userTable.id });

          if (!refundedUser) {
            throw new ApiError(404, 'Bid Owner Not Found!');
          }

          await tx.insert(walletEventTable).values({
            userId: order.userId,
            amount: refund,
            type: 'credit',
            metadata: {
              title: 'Market Resolution - Bid Refund',
              marketId,
              orderId: order.id,
              quantity: remaining,
            },
          });

          totalRefunded += refund;
        }
      } else {
        // Return reserved ask stocks and their cost basis.
        const returnedCost = order.amount * order.remainingStocks;

        if (!Number.isSafeInteger(returnedCost) || returnedCost < 0) {
          throw new ApiError(400, 'Invalid Reserved Cost Basis!');
        }

        await tx
          .insert(stockHoldingTable)
          .values({
            userId: order.userId,
            marketId,
            quantity: remaining,
            outcome: order.outcome,
          })
          .onConflictDoUpdate({
            target: [
              stockHoldingTable.userId,
              stockHoldingTable.marketId,
              stockHoldingTable.outcome,
            ],
            set: {
              quantity: sql`
                  ${stockHoldingTable.quantity} + ${remaining}
                `,
              updatedAt: new Date(),
            },
          });

        totalReturnedStocks += remaining;
      }

      // Preserve order history.
      await tx
        .update(orderTable)
        .set({
          isCancelled: true,
        })
        .where(eq(orderTable.id, order.id));
    }

    //  Fetch winning holdings after returning reserved ask stocks.
    const winningHoldings = await tx
      .select()
      .from(stockHoldingTable)
      .where(
        and(
          eq(stockHoldingTable.marketId, marketId),
          eq(stockHoldingTable.outcome, resolved),
          gt(stockHoldingTable.quantity, 0)
        )
      )
      .for('update');

    let totalPayout = 0;
    let winningUsers = 0;

    // 6. Pay winners 2x their invested amount.
    for (const holding of winningHoldings) {
      const payout = holding.quantity * market.amount * 2;

      if (!Number.isSafeInteger(payout) || payout < 0) {
        throw new ApiError(400, 'Invalid Winning Payout!');
      }

      if (payout === 0) continue;

      const [paidUser] = await tx
        .update(userTable)
        .set({
          balance: sql`${userTable.balance} + ${payout}`,
        })
        .where(eq(userTable.id, holding.userId))
        .returning({ id: userTable.id });

      if (!paidUser) {
        throw new ApiError(404, 'Winning User Not Found!');
      }

      await tx.insert(walletEventTable).values({
        userId: holding.userId,
        amount: payout,
        type: 'credit',
        metadata: {
          title: 'Market Winning Payout',
          marketId,
          outcome: resolved,
          quantity: holding.quantity,
          amount: market.amount,
          multiplier: 2,
        },
      });

      totalPayout += payout;
      winningUsers++;
    }

    //  Remove all holdings, including losing holdings.
    await tx.delete(stockHoldingTable).where(eq(stockHoldingTable.marketId, marketId));

    const [updatedMarket] = await tx
      .update(marketTable)
      .set({
        resolved,
        verifiedLink,
        updatedAt: new Date(),
      })
      .where(eq(marketTable.id, marketId))
      .returning();

    return {
      market: updatedMarket,
      cancelledOrders: pendingOrders.length,
      totalRefunded,
      totalReturnedStocks,
      winningUsers,
      totalPayout,
    };
  });

  res.status(200).json({
    success: true,
    message: `Market resolved successfully: ${resolved.toUpperCase()}`,
    data: result,
  });
});

export const marketController = {
  createMarket,
  deleteMarket,
  getMarkets,
  split,
  resloveMarket: resolveMarketController,
};

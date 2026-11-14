import { and, asc, desc, eq, gt, ilike, or, sql } from 'drizzle-orm';
import { asyncHandler } from '../lib/async-handler';
import { db } from '../lib/db';
import {
  marketTable,
  orderTable,
  stockHoldingTable,
  userTable,
  walletEventTable,
} from '../lib/db/schema';
import { market, resolveMarket } from '../lib/validations/market';
import { ApiError } from '../lib/api-error';
import type { AuthenticatedRequest } from '../middlewares/verifyUser';

const createMarket = asyncHandler(async (req: AuthenticatedRequest, res) => {
  if (!req.user || !req.user.id) {
    throw new ApiError(401, 'User Not Authenticated!');
  }

  const bodyData = req.body;

  const validData = market.safeParse(bodyData);
  if (!validData.success) {
    throw new ApiError(400, validData.error.message);
  }

  const { title, description, amount, issuedStocks, expiresAt } = validData.data;

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

  const users = await db
    .select({
      id: userTable.id,
      balance: userTable.balance,
    })
    .from(userTable)
    .where(eq(userTable.id, req.user.id))
    .limit(1);

  if (users.length === 0 || !users[0]) {
    throw new ApiError(404, 'User Not Found!');
  }

  if (users[0].balance < amount) {
    throw new ApiError(400, 'Not Enough Balance!');
  }

  const newMarkets = await db
    .insert(marketTable)
    .values({
      title,
      description,
      ownerId: req.user.id,
      amount,
      issuedStocks,
      expiresAt,
    })
    .returning({
      id: marketTable.id,
    });

  if (newMarkets.length === 0 || !newMarkets[0]) {
    throw new ApiError(500, 'Market Not Created!');
  }

  await db
    .update(userTable)
    .set({ balance: users[0].balance - amount })
    .where(eq(userTable.id, req.user.id));

  await db.insert(walletEventTable).values({
    userId: req.user.id,
    amount: amount,
    metadata: {
      type: 'debit',
      marketId: newMarkets[0].id,
    },
  });

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

const resolveMarketController = asyncHandler(async (req: AuthenticatedRequest, res) => {
  if (!req.user?.id) {
    throw new ApiError(401, 'User Not Authenticated!');
  }

  const marketId = req.params.marketId as string;
  if (!marketId) {
    throw new ApiError(400, 'Market ID is required!');
  }

  const parsed = resolveMarket.safeParse(req.body);
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
            metadata: {
              type: 'credit',
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
        metadata: {
          type: 'credit',
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
  resloveMarket: resolveMarketController,
};

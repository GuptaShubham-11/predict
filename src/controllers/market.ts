import { and, asc, desc, eq, ilike, or } from 'drizzle-orm';
import { asyncHandler } from '../lib/async-handler';
import { db } from '../lib/db';
import { marketTable, userTable } from '../lib/db/schema';
import { market } from '../lib/validations/market';
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

  await db
    .update(userTable)
    .set({ balance: users[0].balance - amount })
    .where(eq(userTable.id, req.user.id));

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

export const marketController = {
  createMarket,
  deleteMarket,
  getMarkets,
};

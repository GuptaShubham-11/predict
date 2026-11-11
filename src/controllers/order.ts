import { eq } from 'drizzle-orm';
import { ApiError } from '../lib/api-error';
import { asyncHandler } from '../lib/async-handler';
import { db } from '../lib/db';
import { marketTable, orderTable, userTable } from '../lib/db/schema';
import {
  createOrder as createOrderInput,
  updateOrder as updateOrderInput,
} from '../lib/validations/order';
import type { AuthenticatedRequest } from '../middlewares/verifyUser';

const createOrder = asyncHandler(async (req: AuthenticatedRequest, res) => {
  if (!req.user || !req.user.id) {
    throw new ApiError(401, 'User Not Authenticated!');
  }

  const bodyData = req.body;

  const validData = createOrderInput.safeParse(bodyData);
  if (!validData.success) {
    throw new ApiError(400, validData.error.message);
  }

  const { marketId, amount, type, wantedStocks } = validData.data;

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

  if (type === 'bid' && users[0].balance < amount * wantedStocks) {
    throw new ApiError(400, 'Not Enough Balance!');
  }

  const market = await db
    .select({
      id: marketTable.id,
      amount: marketTable.amount,
      expiresAt: marketTable.expiresAt,
      resolved: marketTable.resolved,
      avilabelStocks: marketTable.avilabelStocks,
    })
    .from(marketTable)
    .where(eq(marketTable.id, marketId))
    .limit(1);

  if (market.length === 0 || !market[0]) {
    throw new ApiError(404, 'Market Not Found!');
  }

  if (market[0].resolved !== null) {
    throw new ApiError(400, 'Market Already Resolved!');
  }

  if (market[0].expiresAt < new Date()) {
    throw new ApiError(400, 'Market Expired!');
  }

  if (market[0].avilabelStocks < wantedStocks) {
    throw new ApiError(400, 'Not Enough Stocks Available!');
  }

  const newOrders = await db
    .insert(orderTable)
    .values({
      userId: req.user.id,
      marketId: marketId,
      amount: amount,
      type: type,
      wantedStocks: wantedStocks,
    })
    .returning({
      id: orderTable.id,
    });

  if (newOrders.length === 0 || !newOrders[0]) {
    throw new ApiError(500, 'Failed To Create Order!');
  }

  res.status(201).json({
    success: true,
    message: 'Order Created Successfully',
    orderId: newOrders[0].id,
  });
});

const updateOrder = asyncHandler(async (req: AuthenticatedRequest, res) => {
  if (!req.user || !req.user.id) {
    throw new ApiError(401, 'User Not Authenticated!');
  }

  const orderId = req.params.orderId as string;
  if (!orderId) {
    throw new ApiError(400, 'Order ID is required!');
  }

  const bodyData = req.body;

  const validData = updateOrderInput.safeParse(bodyData);
  if (!validData.success) {
    throw new ApiError(400, validData.error.message);
  }

  const { amount, wantedStocks } = validData.data;

  const orders = await db
    .select({
      id: orderTable.id,
      userId: orderTable.userId,
      marketId: orderTable.marketId,
      amount: orderTable.amount,
      type: orderTable.type,
      wantedStocks: orderTable.wantedStocks,
    })
    .from(orderTable)
    .where(eq(orderTable.id, orderId))
    .limit(1);

  if (orders.length === 0 || !orders[0]) {
    throw new ApiError(404, 'Order Not Found!');
  }

  if (orders[0].userId !== req.user.id) {
    throw new ApiError(403, 'You Are Not The Owner Of This Order!');
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

  if (orders[0].type === 'bid' && users[0].balance < amount * wantedStocks) {
    throw new ApiError(400, 'Not Enough Balance!');
  }

  const market = await db
    .select({
      id: marketTable.id,
      amount: marketTable.amount,
      expiresAt: marketTable.expiresAt,
      resolved: marketTable.resolved,
      avilabelStocks: marketTable.avilabelStocks,
    })
    .from(marketTable)
    .where(eq(marketTable.id, orders[0].marketId))
    .limit(1);

  if (market.length === 0 || !market[0]) {
    throw new ApiError(404, 'Market Not Found!');
  }

  if (market[0].resolved !== null) {
    throw new ApiError(400, 'Market Already Resolved!');
  }

  if (market[0].expiresAt < new Date()) {
    throw new ApiError(400, 'Market Expired!');
  }

  if (market[0].avilabelStocks < wantedStocks) {
    throw new ApiError(400, 'Not Enough Stocks Available!');
  }

  const updatedOrder = await db
    .update(orderTable)
    .set({
      amount: amount,
      wantedStocks: wantedStocks,
    })
    .where(eq(orderTable.id, orderId))
    .returning({
      id: orderTable.id,
    });

  if (updatedOrder.length === 0 || !updatedOrder[0]) {
    throw new ApiError(500, 'Failed To Update Order!');
  }

  res.status(200).json({
    success: true,
    message: 'Order Updated Successfully',
    updatedOrderId: updatedOrder[0].id,
  });
});

const deleteOrder = asyncHandler(async (req: AuthenticatedRequest, res) => {
  if (!req.user || !req.user.id) {
    throw new ApiError(401, 'User Not Authenticated!');
  }

  const orderId = req.params.orderId as string;
  if (!orderId) {
    throw new ApiError(400, 'Order ID is required!');
  }

  const order = await db
    .select({
      id: orderTable.id,
      userId: orderTable.userId,
    })
    .from(orderTable)
    .where(eq(orderTable.id, orderId))
    .limit(1);

  if (order.length === 0 || !order[0]) {
    throw new ApiError(404, 'Order Not Found!');
  }

  if (order[0].userId !== req.user.id) {
    throw new ApiError(403, 'You Are Not The Owner Of This Order!');
  }

  await db.delete(orderTable).where(eq(orderTable.id, orderId));

  res.status(200).json({
    success: true,
    message: 'Order Deleted Successfully',
    deletedOrderId: orderId,
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
      wantedStocks: orderTable.wantedStocks,
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
      wantedStocks: orderTable.wantedStocks,
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

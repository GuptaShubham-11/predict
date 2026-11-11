import { Router } from 'express';
import { verifyUser } from '../middlewares/verifyUser';
import { orderController } from '../controllers/order';

export const orderRoutes = Router();

orderRoutes.use(verifyUser);

orderRoutes.post('/create', orderController.createOrder);
orderRoutes.put('/update/:orderId', orderController.updateOrder);
orderRoutes.delete('/delete/:orderId', orderController.deleteOrder);
orderRoutes.get('/get-market-orders/:marketId', orderController.getOrdersByMarketId);
orderRoutes.get('/get-user-orders', orderController.getOrdersByUserId);

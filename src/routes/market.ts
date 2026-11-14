import { Router } from 'express';
import { verifyUser } from '../middlewares/verifyUser';
import { marketController } from '../controllers/market';

export const marketRouter = Router();

marketRouter.use(verifyUser);
marketRouter.post('/create', marketController.createMarket);
marketRouter.delete('/delete/:marketId', marketController.deleteMarket);
marketRouter.get('/', marketController.getMarkets);
marketRouter.put('/resolve/:marketId', marketController.resloveMarket);

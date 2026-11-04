import { Router } from 'express';
import { userController } from '../controllers/user';
import { verifyUser } from '../middlewares/verifyUser';

const userRouter = Router();

userRouter.use(verifyUser);

userRouter.post('/increase-balance', userController.increaseBalance);

export { userRouter };

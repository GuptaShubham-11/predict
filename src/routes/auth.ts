import { Router } from 'express';
import { userController } from '../controllers/user';

const authRouter = Router();

authRouter.post('/signup', userController.signUp);
authRouter.post('/signin', userController.signIn);
authRouter.get('/refresh-token', userController.refreshToken);

export { authRouter };

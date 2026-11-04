import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';

const app = express();
app.use(express.json({ limit: '16kb' }));
app.use(cookieParser());

import { authRouter } from './routes/auth';
app.use('/api/v1/auth', authRouter);

import { userRouter } from './routes/user';
app.use('/api/v1/user', userRouter);

// Global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('❌ Error:', err.message);
  res.status(500).json({ message: err.message || 'Internal Server Error' });
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server is running on port http://localhost:${process.env.PORT || 3000}/api/v1`);
});

export { app };

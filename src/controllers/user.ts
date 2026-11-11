import { eq } from 'drizzle-orm';
import { asyncHandler } from '../lib/async-handler';
import { db } from '../lib/db';
import { userTable, walletEventTable } from '../lib/db/schema';
import { auth } from '../lib/validations/auth';
import * as argon2 from 'argon2';
import { ApiError } from '../lib/api-error';
import jwt, { type Secret } from 'jsonwebtoken';
import type { AuthenticatedRequest } from '../middlewares/verifyUser';

const signUp = asyncHandler(async (req, res) => {
  const bodyData = req.body;

  const validData = auth.safeParse(bodyData);
  if (!validData.success) {
    throw new ApiError(400, validData.error.message);
  }

  const { username, password } = validData.data;

  const isExistingUser = await db.select().from(userTable).where(eq(userTable.username, username));

  if (isExistingUser.length > 0) {
    throw new ApiError(409, 'User Found With This Username!');
  }

  const passwordHash = await argon2.hash(password);

  const users = await db
    .insert(userTable)
    .values({
      username,
      passwordHash,
    })
    .returning({
      id: userTable.id,
      username: userTable.username,
    });

  if (users.length === 0 || !users[0]) {
    throw new ApiError(500, 'User Not Created!');
  }

  res.status(201).json({
    success: true,
    message: 'User Created Successfully',
    user: users[0],
  });
});

const generateAccessToken = (userId: string): string => {
  try {
    if (!process.env.JWT_ACCESS_SECRET)
      throw new ApiError(500, 'JWT_ACCESS_SECRET is not defined in environment variables');
    if (!process.env.JWT_ACCESS_EXPIRES_IN)
      throw new ApiError(500, 'JWT_ACCESS_EXPIRES_IN is not defined in environment variables');
    if (!userId) throw new ApiError(400, 'User ID is required to generate access token');

    return jwt.sign({ id: userId }, process.env.JWT_ACCESS_SECRET as Secret, {
      expiresIn: Number(process.env.JWT_ACCESS_EXPIRES_IN),
    });
  } catch (error) {
    throw new ApiError(
      500,
      error instanceof Error ? error.message : 'Error generating access token'
    );
  }
};

const generateRefreshToken = (userId: string): string => {
  try {
    if (!process.env.JWT_REFRESH_SECRET)
      throw new ApiError(500, 'JWT_REFRESH_SECRET is not defined in environment variables');
    if (!process.env.JWT_REFRESH_EXPIRES_IN)
      throw new ApiError(500, 'JWT_REFRESH_EXPIRES_IN is not defined in environment variables');
    if (!userId) throw new ApiError(400, 'User ID is required to generate refresh token');

    return jwt.sign({ id: userId }, process.env.JWT_REFRESH_SECRET as Secret, {
      expiresIn: Number(process.env.JWT_REFRESH_EXPIRES_IN),
    });
  } catch (error) {
    throw new ApiError(
      500,
      error instanceof Error ? error.message : 'Error generating refresh token'
    );
  }
};

const COOKIE_OPTIONS: {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'strict';
  maxAge: number;
} = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: Number(process.env.JWT_ACCESS_EXPIRES_IN) * 1000,
};

const signIn = asyncHandler(async (req, res) => {
  const bodyData = req.body;

  const validData = auth.safeParse(bodyData);
  if (!validData.success) {
    throw new ApiError(400, validData.error.message);
  }

  const { username, password } = validData.data;

  const user = await db
    .select({
      id: userTable.id,
      username: userTable.username,
      passwordHash: userTable.passwordHash,
    })
    .from(userTable)
    .where(eq(userTable.username, username))
    .limit(1);

  if (user.length === 0 || !user[0]) {
    throw new ApiError(404, 'User Not Found!');
  }

  const isPasswordValid = await argon2.verify(user[0].passwordHash, password);
  if (!isPasswordValid) {
    throw new ApiError(401, 'Invalid Password!');
  }

  const accessToken = generateAccessToken(user[0].id);
  const refreshToken = generateRefreshToken(user[0].id);

  res
    .status(200)
    .cookie('accessToken', accessToken, COOKIE_OPTIONS)
    .cookie('refreshToken', refreshToken, COOKIE_OPTIONS)
    .json({
      success: true,
      message: 'User Signed In Successfully',
    });
});

const refreshToken = asyncHandler(async (req, res) => {
  const refreshToken = req.cookies.refreshToken;

  if (!refreshToken) {
    throw new ApiError(401, 'Refresh Token Not Found!');
  }

  const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET as Secret);
  if (!decoded || typeof decoded === 'string' || !('id' in decoded)) {
    throw new ApiError(401, 'Invalid Refresh Token!');
  }

  const users = await db
    .select({
      id: userTable.id,
    })
    .from(userTable)
    .where(eq(userTable.id, decoded.id))
    .limit(1);

  if (users.length === 0 || !users[0]) {
    throw new ApiError(404, 'User Not Found!');
  }

  const newAccessToken = generateAccessToken(users[0].id);

  res
    .status(200)
    .clearCookie('accessToken')
    .cookie('accessToken', newAccessToken, COOKIE_OPTIONS)
    .json({
      success: true,
      message: 'Access Token Refreshed Successfully',
    });
});

const increaseBalance = asyncHandler(async (req: AuthenticatedRequest, res) => {
  if (!req.user || !req.user.id) {
    throw new ApiError(401, 'User Not Authenticated!');
  }

  const user = await db
    .select({
      id: userTable.id,
      balance: userTable.balance,
    })
    .from(userTable)
    .where(eq(userTable.id, req.user.id))
    .limit(1);

  if (user.length === 0 || !user[0]) {
    throw new ApiError(404, 'User Not Found!');
  }

  if (user[0].balance >= 100) {
    throw new ApiError(400, 'Balance Already Full!');
  }

  let newBalance = user[0].balance;
  const incresedBalance = 100 - user[0].balance > 20 ? 20 : 100 - user[0].balance;
  newBalance += incresedBalance;

  await db.update(userTable).set({ balance: newBalance }).where(eq(userTable.id, req.user.id));

  await db.insert(walletEventTable).values({
    userId: req.user.id,
    amount: incresedBalance,
    metadata: {
      type: 'credit',
    },
  });

  res.status(200).json({
    success: true,
    message: 'Balance Increased Successfully',
    balance: newBalance,
  });
});

export const userController = {
  signUp,
  signIn,
  increaseBalance,
  refreshToken,
};

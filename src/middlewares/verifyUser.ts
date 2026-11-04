import type { Request, Response, NextFunction } from 'express';
import jwt, { type JwtPayload, type Secret } from 'jsonwebtoken';
import { ApiError } from '../lib/api-error';
import { asyncHandler } from '../lib/async-handler';
import { userTable } from '../lib/db/schema';
import { db } from '../lib/db';
import { eq } from 'drizzle-orm';

interface DecodedToken extends JwtPayload {
  id: string;
}

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    username: string;
  };
}

export const verifyUser = asyncHandler(
  async (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
    const token = req.cookies?.accessToken || req.header('Authorization')?.replace('Bearer ', '');

    if (!token) {
      throw new ApiError(400, 'No token provided.');
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET as Secret) as DecodedToken;

      if (!decoded || !decoded.id) {
        throw new ApiError(401, 'Token verification failed.');
      }

      const user = await db
        .select({
          id: userTable.id,
          username: userTable.username,
        })
        .from(userTable)
        .where(eq(userTable.id, decoded.id));

      if (user.length === 0 || !user[0]) {
        throw new ApiError(404, 'User not found.');
      }

      req.user = user[0];
      next();
    } catch (error) {
      throw new ApiError(
        401,
        error instanceof ApiError ? error.message : 'Token verification failed.'
      );
    }
  }
);

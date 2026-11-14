import z from 'zod';

export const createMarketInput = z.object({
  title: z.string().min(1, 'Title is required').max(100, 'Title must be less than 100 characters'),
  description: z
    .string()
    .min(1, 'Description is required')
    .max(500, 'Description must be less than 500 characters'),
  expiresAt: z
    .date()
    .refine((date) => date > new Date(), { message: 'Date must be in the future' }),
});

export const resolveMarketInput = z.object({
  resolved: z.enum(['yes', 'no']),
  verifiedLink: z.string().min(1, 'Verified Link is required'),
});

export const splitInput = z.object({
  amount: z
    .number()
    .int()
    .positive()
    .min(1, 'Amount must be at least 1')
    .max(1000, 'Amount must be at most 100'),
});

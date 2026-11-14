import z from 'zod';

export const market = z.object({
  title: z.string().min(1, 'Title is required').max(100, 'Title must be less than 100 characters'),
  description: z
    .string()
    .min(1, 'Description is required')
    .max(500, 'Description must be less than 500 characters'),
  amount: z.number().int().min(1, 'Amount must be at least 1'),
  issuedStocks: z
    .number()
    .int()
    .min(1, 'Issued stocks must be at least 1')
    .max(1000, 'Issued stocks must be less than or equal to 1,000'),
  expiresAt: z
    .date()
    .refine((date) => date > new Date(), { message: 'Date must be in the future' }),
});

export const resolveMarket = z.object({
  resolved: z.enum(['yes', 'no']),
  verifiedLink: z.string().min(1, 'Verified Link is required'),
});

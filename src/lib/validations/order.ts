import z from 'zod';

export const createOrder = z.object({
  amount: z.number().int().min(1, 'Amount must be at least 1'),
  wantedStocks: z.number().int().min(1, 'Wanted stocks must be at least 1'),
  type: z.enum(['ask', 'bid']),
  marketId: z.string().min(1, 'Market ID is required'),
});

export const updateOrder = z.object({
  amount: z.number().int().min(1, 'Amount must be at least 1'),
  wantedStocks: z.number().int().min(1, 'Wanted stocks must be at least 1'),
});

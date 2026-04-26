// routes/admin/index.ts
import { Router, Response } from 'express';
import { requireAuth, AuthenticatedRequest } from '../../middleware/auth';
import { adminProductsRouter } from './adminProducts';
import { adminDashboardRouter } from './dashboard';
import { adminPaymentsRouter } from './payments';
import { adminUsersRouter } from './users';

const router = Router();

router.use(requireAuth);

router.get('/me', (req: AuthenticatedRequest, res: Response) => {
  res.json({ success: true, data: req.admin });
});

router.use('/dashboard', adminDashboardRouter);
router.use('/payments', adminPaymentsRouter);
router.use('/products', adminProductsRouter);
router.use('/users', adminUsersRouter);

export default router;

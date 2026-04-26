<<<<<<< HEAD
import { Router, Response } from 'express';
import { requireAuth } from '../../middleware/auth';
import { AuthenticatedRequest } from '../../middleware/requireAuth';
=======
// routes/admin/index.ts
import { Router, Response } from 'express';
import { requireAuth, AuthenticatedRequest } from '../../middleware/auth';
>>>>>>> 5d6c0b3 (descrição do que mudou)
import { adminProductsRouter } from './adminProducts';
import { adminDashboardRouter } from './dashboard';
import { adminPaymentsRouter } from './payments';
import { adminUsersRouter } from './users';

const router = Router();

router.use(requireAuth);

<<<<<<< HEAD
// ✅ Rota /me — retorna o admin logado
=======
>>>>>>> 5d6c0b3 (descrição do que mudou)
router.get('/me', (req: AuthenticatedRequest, res: Response) => {
  res.json({ success: true, data: req.admin });
});

router.use('/dashboard', adminDashboardRouter);
router.use('/payments', adminPaymentsRouter);
router.use('/products', adminProductsRouter);
router.use('/users', adminUsersRouter);

export default router;

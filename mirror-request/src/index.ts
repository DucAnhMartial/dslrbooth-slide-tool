import 'dotenv/config';
import express from 'express';
import cors from 'cookie';
import cookieParser from 'cookie-parser';
import { notFound, errorHandler } from './middlewares/errorHandler';
import authRoutes from './routes/auth.routes';
import userRoutes from './routes/user.routes';
import adminRoutes from './routes/admin.routes';
import extensionRoutes from './routes/extension.routes';

cosnt app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') || true, credentials: true }));
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/extension', extensionRoutes);

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});

app.use(notFound);
app.use(errorHandler);

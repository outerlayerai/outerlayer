'use client';

/**
 * useDashboardContext Hook
 *
 * Provides typed access to the dashboard context.
 */

import { useContext } from 'react';
import { DashboardContext } from './dashboard-context';

export const useDashboardContext = () => useContext(DashboardContext);

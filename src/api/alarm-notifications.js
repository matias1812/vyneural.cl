// src/api/alarm-notifications.js
// Historial de notificaciones de alarma ENVIADAS por el backend — ver
// backend/app/models/alarm_notification.py. Es un registro de envío
// (FCM/Web Push), no de entrega ni reproducción (REGLA DE ORO: el backend
// nunca inicia audio).

import { cachedGet, post } from './client.js';

export const listAlarmNotifications = (limit = 20) => cachedGet(`/api/v1/alarms/notifications?limit=${limit}`);

// Dispara un push AHORA (sin esperar una alarma vencida) — para que el
// usuario aísle en un toque si el envío (FCM/Web Push) funciona o no.
export const testAlarmNotification = () => post('/api/v1/alarms/test-notification', {});

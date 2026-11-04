package com.vyneural.bineural.sync

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Dispara el ciclo de sincronización del servidor (alarmas + reporte de
 * dispositivo). Lo invoca únicamente el PendingIntent del ciclo periódico
 * de AlarmSync (nunca externos: exported=false).
 */
class AlarmSyncReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == AlarmSync.ACTION_SYNC) {
            AlarmSync.run(context)
        }
    }
}

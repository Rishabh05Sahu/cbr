package com.crystalbricks.crm

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.pm.ApplicationInfo
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import io.flutter.embedding.android.FlutterActivity

class MainActivity : FlutterActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Release builds block screenshots, screen recording and the recent-apps preview, so lead
        // phone numbers and details cannot be captured (ADR-0027). Debug builds allow them.
        val debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        if (!debuggable) {
            window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        }
        // The channel push notifications arrive on (ADR-0027 slice 5). Private: a lock screen set to
        // hide sensitive content shows "Contents hidden" (titles name leads).
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                "crm_updates", "Leads and tasks", NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = "New leads assigned to you, task and visit reminders"
                lockscreenVisibility = android.app.Notification.VISIBILITY_PRIVATE
            }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }
}

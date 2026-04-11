const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();
const messaging = admin.messaging();

// Triggered when a new notification document is created in Firestore
exports.sendPushNotification = functions.firestore
  .document('notifications/{notifId}')
  .onCreate(async (snap, context) => {
    const data = snap.data();
    if (!data || data.sent) return null;

    const { toUid, title, body } = data;
    if (!toUid || !title) {
      await snap.ref.update({ sent: true, error: 'Missing toUid or title' });
      return null;
    }

    try {
      // Get the recipient's FCM token
      const userDoc = await db.collection('users').doc(toUid).get();
      if (!userDoc.exists) {
        await snap.ref.update({ sent: true, error: 'User not found' });
        return null;
      }

      const fcmToken = userDoc.data().fcmToken;
      if (!fcmToken) {
        await snap.ref.update({ sent: true, error: 'No FCM token for user' });
        return null;
      }

      // Send the notification
      await messaging.send({
        token: fcmToken,
        notification: { title, body: body || '' },
        webpush: {
          notification: {
            title,
            body: body || '',
            icon: 'https://eweome-41e0f.web.app/icon-192.png',
            badge: 'https://eweome-41e0f.web.app/icon-192.png',
            requireInteraction: false
          },
          fcmOptions: { link: 'https://eweome-41e0f.web.app' }
        }
      });

      await snap.ref.update({ sent: true, sentAt: admin.firestore.FieldValue.serverTimestamp() });
      console.log(`Notification sent to ${toUid}: ${title}`);
      return null;

    } catch (e) {
      console.error('Error sending notification:', e.message);
      await snap.ref.update({ sent: true, error: e.message });
      return null;
    }
  });

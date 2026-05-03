const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();
const messaging = admin.messaging();

// Triggered when a new notification document is created
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
      const userDoc = await db.collection('users').doc(toUid).get();
      if (!userDoc.exists) {
        await snap.ref.update({ sent: true, error: 'User not found' });
        return null;
      }
      const fcmToken = userDoc.data().fcmToken;
      if (!fcmToken) {
        await snap.ref.update({ sent: true, error: 'No FCM token' });
        return null;
      }
await messaging.send({
  token: fcmToken,
  notification: { title: 'ewe-o-me', body: 'You have new activity — open the app to catch up.' },
  webpush: {
    notification: {
      title: 'ewe-o-me', body: 'You have new activity — open the app to catch up.',
      icon: 'https://eweome-41e0f.web.app/icon-192.png',
      requireInteraction: false
    },
    fcmOptions: { link: 'https://eweome-41e0f.web.app' }
  }
});
      await snap.ref.update({ sent: true, sentAt: admin.firestore.FieldValue.serverTimestamp() });
      console.log('Notification sent to', toUid, ':', title);
      return null;
    } catch(e) {
      console.error('Error sending notification:', e.message);
      await snap.ref.update({ sent: true, error: e.message });
      return null;
    }
  });

// Triggered when a new user doc is created — link any pending claims
exports.linkPendingClaims = functions.firestore
  .document('users/{userId}')
  .onCreate(async (snap, context) => {
    const uid = context.params.userId;
    const userData = snap.data();
    const phone = userData.phone;
    if (!phone) return null;
    try {
      // Find any claims with this pendingPhone
      const pending = await db.collection('claims')
        .where('pendingPhone', '==', phone)
        .get();
      if (pending.empty) return null;
      const batch = db.batch();
      pending.docs.forEach(doc => {
        const claim = doc.data();
        const isCred = claim.creditorUid !== null;
        function bestName(appName, phone, claimName) {
  if (appName && !/^\+?[\d\s\-()]+$/.test(appName.trim())) return appName;
  if (claimName && !/^\+?[\d\s\-()]+$/.test(claimName.trim())) return claimName;
  return phone;
}
        function bestName(appName, phone, claimName) {
  if (appName && !/^\+?[\d\s\-()]+$/.test(appName.trim())) return appName;
  if (claimName && !/^\+?[\d\s\-()]+$/.test(claimName.trim())) return claimName;
  return phone;
}
        batch.update(doc.ref, {
          debtorUid:    isCred ? uid : claim.debtorUid,
          debtorName:  isCred ? bestName(userData.displayName, phone, claim.debtorName)  : claim.debtorName,
          creditorUid:  isCred ? claim.creditorUid : uid,
          creditorName: isCred ? claim.creditorName : bestName(userData.displayName, phone, claim.creditorName),
          participants: isCred ? [claim.creditorUid, uid] : [uid, claim.debtorUid],
          pendingPhone: null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      });
      await batch.commit();
      console.log('Linked', pending.size, 'pending claims for', phone, '->', uid);
      // Notify the new user about waiting claims
      if (pending.size > 0) {
        await db.collection('notifications').add({
          toUid: uid,
          title: 'You have ' + pending.size + ' waiting request' + (pending.size > 1 ? 's' : ''),
          body: 'Someone logged a debt with you before you joined. Check your Pending tab.',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          sent: false
        });
      }
      return null;
    } catch(e) {
      console.error('Error linking pending claims:', e.message);
      return null;
    }
  });

  // Runs daily — nudges people who have unactioned claims older than 7 days
  exports.sendClaimReminders = functions.pubsub
  .schedule('every 24 hours')
  .timeZone('Europe/London')
  .onRun(async (context) => {
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const snap = await db.collection('claims')
      .where('status', 'in', ['pending', 'queried'])
      .get();

    for (const doc of snap.docs) {
      const claim = doc.data();

      // Skip if updated recently (still active conversation)
      const updatedAt = claim.updatedAt?.toDate?.() || new Date(0);
      if (updatedAt > oneWeekAgo) continue;

      // Skip if we already sent a reminder within the last 7 days
      const lastReminder = claim.lastReminderAt?.toDate?.() || new Date(0);
      if (lastReminder > oneWeekAgo) continue;

      // Work out who needs to act
      let notifyUid = null;
      const isIOU = claim.type === 'ioowe';

      if (claim.status === 'pending') {
        // YOM: debtor needs to act. IOU: creditor needs to act.
        notifyUid = isIOU ? claim.creditorUid : claim.debtorUid;
      } else if (claim.status === 'queried') {
        if (claim.answeredQuestion) {
          // Debtor asked question, creditor answered — debtor needs to decide
          notifyUid = claim.debtorUid;
        } else if (claim.counterAmount || claim.question) {
          // Debtor countered or asked question — creditor needs to respond
          notifyUid = claim.creditorUid;
        }
      }

      if (!notifyUid) continue;

      try {
        await db.collection('notifications').add({
          toUid: notifyUid,
          title: 'ewe-o-me',
          body: 'You have new activity — open the app to catch up.',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          sent: false
        });

        await doc.ref.update({
          lastReminderAt: admin.firestore.FieldValue.serverTimestamp()
        });

        console.log('Reminder sent for claim', doc.id, 'to', notifyUid);
      } catch (e) {
        console.error('Error sending reminder for claim', doc.id, ':', e.message);
      }
    }

    return null;
  });

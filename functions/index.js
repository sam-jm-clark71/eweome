const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();
const messaging = admin.messaging();

// ================================================================
// DEBT SIMPLIFICATION HELPERS
// ================================================================

// Build net balance map from a list of claims
function buildNetBalances(claims) {
  const net = {}; // uid -> { name, bal }
  claims.forEach(c => {
    if (!net[c.creditorUid]) net[c.creditorUid] = { name: c.creditorName, bal: 0 };
    if (!net[c.debtorUid])   net[c.debtorUid]   = { name: c.debtorName,   bal: 0 };
    const remaining = Math.max(0, (c.amount || 0) - (c.amountPaid || 0));
    net[c.creditorUid].bal += remaining;
    net[c.debtorUid].bal   -= remaining;
  });
  return net;
}

// Minimum cash flow algorithm — returns array of {from, to, amount}
function minimizeCashFlow(balances) {
  const creditors = Object.entries(balances)
    .filter(([, v]) => v.bal > 0.005)
    .map(([id, v]) => ({ id, name: v.name, bal: v.bal }))
    .sort((a, b) => b.bal - a.bal);
  const debtors = Object.entries(balances)
    .filter(([, v]) => v.bal < -0.005)
    .map(([id, v]) => ({ id, name: v.name, bal: -v.bal }))
    .sort((a, b) => b.bal - a.bal);

  const transfers = [];
  let ci = 0, di = 0;
  while (ci < creditors.length && di < debtors.length) {
    const cr = creditors[ci], dr = debtors[di];
    const amount = Math.min(cr.bal, dr.bal);
    if (amount > 0.005) {
      transfers.push({ from: dr.id, fromName: dr.name, to: cr.id, toName: cr.name, amount: Math.round(amount * 100) / 100 });
    }
    cr.bal -= amount; dr.bal -= amount;
    if (cr.bal < 0.005) ci++;
    if (dr.bal < 0.005) di++;
  }
  return transfers;
}

// Find all groups of interconnected users (connected components in debt graph)
function findConnectedGroups(claims) {
  const adj = {}; // uid -> Set of uids
  claims.forEach(c => {
    if (!adj[c.creditorUid]) adj[c.creditorUid] = new Set();
    if (!adj[c.debtorUid])   adj[c.debtorUid]   = new Set();
    adj[c.creditorUid].add(c.debtorUid);
    adj[c.debtorUid].add(c.creditorUid);
  });

  const visited = new Set();
  const groups = [];

  for (const uid of Object.keys(adj)) {
    if (visited.has(uid)) continue;
    const group = new Set();
    const queue = [uid];
    while (queue.length > 0) {
      const cur = queue.shift();
      if (visited.has(cur)) continue;
      visited.add(cur);
      group.add(cur);
      (adj[cur] || new Set()).forEach(n => { if (!visited.has(n)) queue.push(n); });
    }
    if (group.size >= 3) groups.push([...group]);
  }
  return groups;
}

// Preserve the name given at claim time if the user has no display name
function bestName(appName, phone, claimName) {
  if (appName && !/^\+?[\d\s\-()]+$/.test(appName.trim())) return appName;
  if (claimName && !/^\+?[\d\s\-()]+$/.test(claimName.trim())) return claimName;
  return phone;
}

// ================================================================
// TRIGGERED FUNCTIONS
// ================================================================

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
      const pending = await db.collection('claims')
        .where('pendingPhone', '==', phone)
        .get();
      if (pending.empty) return null;
      const batch = db.batch();
      pending.docs.forEach(doc => {
        const claim = doc.data();
        const isCred = claim.creditorUid !== null;
        batch.update(doc.ref, {
          debtorUid:    isCred ? uid : claim.debtorUid,
          debtorName:   isCred ? bestName(userData.displayName, phone, claim.debtorName)  : claim.debtorName,
          creditorUid:  isCred ? claim.creditorUid : uid,
          creditorName: isCred ? claim.creditorName : bestName(userData.displayName, phone, claim.creditorName),
          participants: isCred ? [claim.creditorUid, uid] : [uid, claim.debtorUid],
          pendingPhone: null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      });
      await batch.commit();
      console.log('Linked', pending.size, 'pending claims for', phone, '->', uid);
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

// Triggered when a simplification document is updated
// If all consents are in, either execute or decline
exports.onSimplificationUpdated = functions.firestore
  .document('simplifications/{simplificationId}')
  .onUpdate(async (change, context) => {
    const simp = change.after.data();
    if (simp.status !== 'pending_consent') return null;

    const consents = simp.consents || {};
    const participants = simp.participants || [];

    // Check if anyone declined
    if (Object.values(consents).some(c => c === false)) {
      await change.after.ref.update({
        status: 'declined',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      for (const uid of participants) {
        await db.collection('notifications').add({
          toUid: uid,
          title: 'ewe-o-me',
          body: 'You have new activity — open the app to catch up.',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          sent: false
        });
      }
      console.log('Simplification', context.params.simplificationId, 'declined');
      return null;
    }

    // Check if all have agreed
    if (!participants.every(uid => consents[uid] === true)) return null;

    // All agreed — execute the simplification
    console.log('All agreed — executing simplification', context.params.simplificationId);

    const batch = db.batch();

    // Settle all affected claims
    for (const claimId of (simp.affectedClaimIds || [])) {
      batch.update(db.collection('claims').doc(claimId), {
        status: 'settled',
        settledBy: 'simplification',
        simplificationId: context.params.simplificationId,
        settledAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    // Create new simplified claims (already agreed — skip the pending flow)
    const today = new Date().toISOString().split('T')[0];
    for (const debt of (simp.proposedDebts || [])) {
      const newRef = db.collection('claims').doc();
      batch.set(newRef, {
        creditorUid:  debt.to,
        creditorName: (simp.participantNames || {})[debt.to] || 'Unknown',
        debtorUid:    debt.from,
        debtorName:   (simp.participantNames || {})[debt.from] || 'Unknown',
        amount:       debt.amount,
        description:  'Simplified debt',
        status:       'agreed',
        type:         'eweome',
        participants: [debt.to, debt.from],
        date:         today,
        simplificationId: context.params.simplificationId,
        createdAt:    admin.firestore.FieldValue.serverTimestamp(),
        updatedAt:    admin.firestore.FieldValue.serverTimestamp()
      });
    }

    // Mark simplification as completed
    batch.update(change.after.ref, {
      status: 'completed',
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await batch.commit();

    // Notify everyone
    for (const uid of participants) {
      await db.collection('notifications').add({
        toUid: uid,
        title: 'ewe-o-me',
        body: 'You have new activity — open the app to catch up.',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        sent: false
      });
    }

    console.log('Simplification', context.params.simplificationId, 'completed');
    return null;
  });

// ================================================================
// SCHEDULED FUNCTIONS
// ================================================================

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

      const updatedAt = claim.updatedAt?.toDate?.() || new Date(0);
      if (updatedAt > oneWeekAgo) continue;

      const lastReminder = claim.lastReminderAt?.toDate?.() || new Date(0);
      if (lastReminder > oneWeekAgo) continue;

      let notifyUid = null;
      const isIOU = claim.type === 'ioowe';

      if (claim.status === 'pending') {
        notifyUid = isIOU ? claim.creditorUid : claim.debtorUid;
      } else if (claim.status === 'queried') {
        if (claim.answeredQuestion) {
          notifyUid = claim.debtorUid;
        } else if (claim.counterAmount || claim.question) {
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

// Runs daily — detects debt loops and proposes simplifications
exports.detectSimplifications = functions.pubsub
  .schedule('every 24 hours')
  .timeZone('Europe/London')
  .onRun(async (context) => {
    console.log('detectSimplifications running');

    const snap = await db.collection('claims')
      .where('status', 'in', ['agreed', 'settlement_pending'])
      .get();

    const claims = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(c => !c.pendingPartialAmount || c.pendingPartialAmount < 0.01);

    if (claims.length === 0) return null;

    const groups = findConnectedGroups(claims);
    console.log('Found', groups.length, 'connected groups');

    for (const groupUids of groups) {
      const groupClaims = claims.filter(c =>
        groupUids.includes(c.creditorUid) && groupUids.includes(c.debtorUid)
      );

      const currentCount = groupClaims.length;
      const netBalances = buildNetBalances(groupClaims);
      const simplified = minimizeCashFlow(netBalances);
      const simplifiedCount = simplified.length;

      if (simplifiedCount >= currentCount) {
        console.log('No improvement for group', groupUids, '- skipping');
        continue;
      }

      const participantKey = [...groupUids].sort().join(',');
      const existing = await db.collection('simplifications')
        .where('status', '==', 'pending_consent')
        .where('participantKey', '==', participantKey)
        .get();

      if (!existing.empty) {
        console.log('Simplification already pending for group', participantKey);
        continue;
      }

      const participantNames = {};
      groupUids.forEach(uid => {
        const entry = netBalances[uid];
        if (entry) participantNames[uid] = entry.name;
      });

      const currentDebts = groupClaims.map(c => ({
        from: c.debtorUid,
        to: c.creditorUid,
        amount: Math.max(0, (c.amount || 0) - (c.amountPaid || 0))
      }));

      const proposedDebts = simplified.map(t => ({
        from: t.from,
        to: t.to,
        amount: t.amount
      }));

      const consents = {};
      groupUids.forEach(uid => { consents[uid] = null; });

      const simplificationRef = await db.collection('simplifications').add({
        participants: groupUids,
        participantKey,
        participantNames,
        currentTransactions: currentCount,
        simplifiedTransactions: simplifiedCount,
        currentDebts,
        proposedDebts,
        affectedClaimIds: groupClaims.map(c => c.id),
        status: 'pending_consent',
        consents,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      console.log('Created simplification', simplificationRef.id, 'for group', participantKey);

      for (const uid of groupUids) {
        await db.collection('notifications').add({
          toUid: uid,
          title: 'ewe-o-me',
          body: 'You have new activity — open the app to catch up.',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          sent: false
        });
      }
    }

    return null;
  });

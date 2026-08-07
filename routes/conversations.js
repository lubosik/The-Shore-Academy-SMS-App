const router = require('express').Router();
const { supabase } = require('../db');
const { reconcileRecentMessageStatuses } = require('../lib/message-status');

router.get('/', async (req, res) => {
  try {
    // Fetch all contacts
    const { data: contacts } = await supabase
      .from('sms_contacts')
      .select('*');

    if (!contacts?.length) return res.json([]);

    // Fetch latest message per contact in one batch
    let { data: allMessages, error: msgErr } = await supabase
      .from('sms_messages')
      .select('contact_phone, body, direction, created_at, media_urls')
      .in('contact_phone', contacts.map(c => c.phone))
      .order('created_at', { ascending: false });

    // Fallback for a not-yet-migrated schema (media_urls column missing)
    if (msgErr) {
      ({ data: allMessages } = await supabase
        .from('sms_messages')
        .select('contact_phone, body, direction, created_at')
        .in('contact_phone', contacts.map(c => c.phone))
        .order('created_at', { ascending: false }));
    }

    // Build lookup map — first entry per phone = latest (already sorted desc)
    const latestMessage = {};
    for (const m of (allMessages || [])) {
      if (!latestMessage[m.contact_phone]) latestMessage[m.contact_phone] = m;
    }

    // Enrich contacts with their latest message
    const enriched = contacts.map(c => ({
      ...c,
      lastMessage: latestMessage[c.phone] || null
    }));

    res.json(enriched);
  } catch (err) {
    console.error('Conversations load error:', err.message);
    res.status(500).json({ error: 'Failed to load conversations' });
  }
});

router.get('/:phone', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    const { data: messages, error } = await supabase
      .from('sms_messages')
      .select('*')
      .eq('contact_phone', phone)
      .order('created_at', { ascending: true });
    if (error) throw error;

    const reconciled = await reconcileRecentMessageStatuses(supabase, messages || []);

    await supabase.from('sms_contacts')
      .update({ unread_count: 0 })
      .eq('phone', phone);

    res.json(reconciled);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load thread' });
  }
});

module.exports = router;

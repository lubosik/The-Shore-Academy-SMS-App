const router = require('express').Router();
const { supabase } = require('../db');
const { reconcileRecentMessageStatuses } = require('../lib/message-status');
const { fetchAllRows } = require('../lib/fetch-all-rows');

router.get('/', async (req, res) => {
  try {
    // Both reads are paged, and neither filters by a list of phone numbers.
    //
    // This route used to pass every contact phone into `.in()`, which puts them
    // in the URL. On the sister app that reached ~11,800 characters at 907
    // contacts and overflowed Node's HTTP header limit, so the query failed
    // after a ~10 second stall. The error was swallowed, every lastMessage came
    // back null, and the inbox rendered phone numbers where message previews
    // belong. Shore is smaller but grows the same way — GHL added 27 leads in a
    // day — so it is fixed here before it can bite.
    //
    // Reading whole tables in pages is also faster: every message belongs to a
    // contact, so filtering by contact bought nothing.
    const [contacts, allMessages] = await Promise.all([
      fetchAllRows(supabase, 'sms_contacts', '*', { orderBy: null }),
      fetchAllRows(supabase, 'sms_messages', 'contact_phone, body, direction, created_at, media_urls')
    ]);

    if (!contacts.length) return res.json([]);

    // Sorted newest-first, so the first entry seen per phone is the latest.
    const latestMessage = {};
    for (const m of allMessages) {
      if (!latestMessage[m.contact_phone]) latestMessage[m.contact_phone] = m;
    }

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

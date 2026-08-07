const router = require('express').Router();
const { supabase } = require('../db');
const { formatPhone } = require('../lib/compliance');

// GET /api/contacts?search=&page=1
// Returns all contacts sorted alphabetically by first_name, last_name
router.get('/', async (req, res) => {
  try {
    const { search, page = 1, per_page: perPage = 100 } = req.query;
    const limit = Math.min(1000, Math.max(1, Number.parseInt(perPage, 10) || 100));
    const pageNumber = Math.max(1, Number.parseInt(page, 10) || 1);
    const batchSize = 1000;
    const rows = [];

    // first_name/last_name are absent on many imported contacts while `name`
    // is populated. Fetch matching rows in chunks, normalise, then sort by the
    // actual display name before paginating so every page is globally A–Z.
    for (let offset = 0; ; offset += batchSize) {
      let query = supabase
        .from('sms_contacts')
        .select('id, phone, first_name, last_name, name, email, notes, unread_count, last_seen, source, ghl_contact_id, ghl_tags, created_at')
        .order('id', { ascending: true })
        .range(offset, offset + batchSize - 1);

      if (search) {
        query = query.or(
          `first_name.ilike.%${search}%,last_name.ilike.%${search}%,name.ilike.%${search}%,phone.ilike.%${search}%,email.ilike.%${search}%`
        );
      }

      const { data, error } = await query;
      if (error) return res.status(500).json({ error: error.message });
      rows.push(...(data || []));
      if ((data?.length || 0) < batchSize) break;
    }

    const normalised = rows.map(normaliseContact).sort((a, b) => {
      const aHasName = Boolean(a.first_name || a.last_name || a.name);
      const bHasName = Boolean(b.first_name || b.last_name || b.name);
      if (aHasName !== bHasName) return aHasName ? -1 : 1;
      const byName = a.display_name.localeCompare(b.display_name, undefined, { sensitivity: 'base', numeric: true });
      return byName || a.phone.localeCompare(b.phone);
    });
    const start = (pageNumber - 1) * limit;
    const contacts = normalised.slice(start, start + limit);

    res.json({ contacts, page: pageNumber, hasMore: start + limit < normalised.length });
  } catch (err) {
    console.error('Contacts list error:', err.message);
    res.status(500).json({ error: 'Failed to load contacts' });
  }
});

// GET /api/contacts/:phone
// Contact profile: contact info + message history. GoHighLevel is the system
// of record for everything else about a person — no orders, no AI profiles.
router.get('/:phone', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);

    const [contactResult, messagesResult] = await Promise.all([
      supabase.from('sms_contacts').select('*').eq('phone', phone).maybeSingle(),
      supabase.from('sms_messages')
        .select('id, telnyx_message_id, direction, body, status, media_urls, reply_to_message_id, reactions, created_at')
        .eq('contact_phone', phone)
        .order('created_at', { ascending: true })
    ]);

    const contact = contactResult.data;
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    if (messagesResult.error) {
      console.error('Contact messages load error:', messagesResult.error.message);
    }

    const messages = messagesResult.data || [];

    res.json({
      contact: normaliseContact(contact),
      messages,
      total_messages: messages.length
    });
  } catch (err) {
    console.error('Contact profile error:', err.message);
    res.status(500).json({ error: 'Failed to load contact profile' });
  }
});

// POST /api/contacts
// Create a new contact manually
router.post('/', async (req, res) => {
  try {
    const { first_name, last_name, phone, email, notes } = req.body;

    if (!phone) return res.status(400).json({ error: 'Phone number is required' });

    const formattedPhone = formatPhone(phone);
    if (!formattedPhone) return res.status(400).json({ error: 'Invalid phone number format' });

    const { data: existing } = await supabase
      .from('sms_contacts')
      .select('id, phone, first_name, last_name, email, notes')
      .eq('phone', formattedPhone)
      .maybeSingle();

    if (existing) {
      const { data: updated } = await supabase
        .from('sms_contacts')
        .update({
          first_name: first_name || existing.first_name,
          last_name: last_name || existing.last_name,
          name: buildFullName(first_name || existing.first_name, last_name || existing.last_name),
          email: email || existing.email,
          notes: notes || existing.notes
        })
        .eq('phone', formattedPhone)
        .select()
        .single();
      return res.json({ contact: normaliseContact(updated), created: false });
    }

    const { data: created, error } = await supabase
      .from('sms_contacts')
      .insert({
        phone: formattedPhone,
        first_name: first_name || null,
        last_name: last_name || null,
        name: buildFullName(first_name, last_name),
        email: email || null,
        notes: notes || null,
        source: 'manual',
        unread_count: 0,
        last_seen: new Date().toISOString()
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    console.log(`[CONTACTS] created | phone=...${formattedPhone.slice(-4)}`);
    res.status(201).json({ contact: normaliseContact(created), created: true });
  } catch (err) {
    console.error('Contact create error:', err.message);
    res.status(500).json({ error: 'Failed to create contact' });
  }
});

// PATCH /api/contacts/:phone
// Update contact details
router.patch('/:phone', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    const { first_name, last_name, name, email, notes, avatar_url, new_phone } = req.body;

    const updates = {};
    if (first_name !== undefined) updates.first_name = first_name;
    if (last_name !== undefined) updates.last_name = last_name;
    if (email !== undefined) updates.email = email;
    if (notes !== undefined) updates.notes = notes;
    if (avatar_url !== undefined) updates.avatar_url = avatar_url;
    if (name !== undefined) updates.name = name;

    if ((first_name !== undefined || last_name !== undefined) && name === undefined) {
      const { data: current } = await supabase
        .from('sms_contacts').select('first_name, last_name').eq('phone', phone).single();
      updates.name = buildFullName(
        first_name ?? current?.first_name,
        last_name ?? current?.last_name
      );
    }

    // Phone change: update only sms_contacts (message history stays on old number)
    if (new_phone) {
      const formatted = formatPhone(new_phone);
      if (!formatted) return res.status(400).json({ error: 'Invalid phone number format' });
      updates.phone = formatted;
    }

    const { data, error } = await supabase
      .from('sms_contacts')
      .update(updates)
      .eq('phone', phone)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ contact: normaliseContact(data) });
  } catch (err) {
    console.error('Contact update error:', err.message);
    res.status(500).json({ error: 'Failed to update contact' });
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function normaliseContact(c) {
  if (!c) return c;
  const first = c.first_name || (c.name ? c.name.split(' ')[0] : '');
  const last  = c.last_name  || (c.name ? c.name.split(' ').slice(1).join(' ') : '');
  return {
    ...c,
    first_name: first,
    last_name:  last,
    display_name: buildFullName(first, last) || c.phone
  };
}

function buildFullName(first, last) {
  return [first, last].filter(Boolean).join(' ').trim();
}

module.exports = router;

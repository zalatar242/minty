/**
 * Synthetic test fixtures — no real user data used here.
 * All contacts, interactions, and insights are invented for test purposes.
 */

function makeContact(overrides = {}) {
    return {
        id: 'c_001',
        name: 'Alice Smith',
        phones: ['+447911555001'],
        emails: ['alice@example.com'],
        notes: null,
        tags: [],
        sources: {
            whatsapp: null,
            linkedin: null,
            telegram: null,
            email: null,
            googleContacts: null,
            sms: null,
        },
        lastContactedAt: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        ...overrides,
    };
}

function makeInteraction(overrides = {}) {
    return {
        id: 'i_001',
        source: 'whatsapp',
        timestamp: '2026-01-15T10:00:00.000Z',
        from: '+447911555001',
        to: 'me',
        body: 'Hey, how are you doing?',
        subject: null,
        chatId: '447911555001@c.us',
        chatName: 'Alice Smith',
        type: 'message',
        raw: {},
        ...overrides,
    };
}

// A set of contacts covering different relationship states
const CONTACTS = {
    strong: makeContact({
        id: 'c_001',
        name: 'Alice Strong',
        phones: ['+447911555001'],
        emails: ['alice@example.com'],
        sources: { whatsapp: { id: '447911555001@c.us' }, linkedin: null, telegram: null, email: null, googleContacts: null, sms: null },
        lastContactedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 days ago
        interactionCount: 200,
        activeChannels: ['whatsapp', 'email', 'linkedin'],
        relationshipScore: 88,
        daysSinceContact: 3,
    }),
    dormant: makeContact({
        id: 'c_002',
        name: 'Bob Dormant',
        phones: ['+447911555002'],
        emails: ['bob@example.com'],
        sources: { whatsapp: { id: '447911555002@c.us' }, linkedin: { name: 'Bob Dormant', company: 'Acme', position: 'CEO' }, telegram: null, email: null, googleContacts: null, sms: null },
        lastContactedAt: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString(), // 120 days ago
        interactionCount: 45,
        activeChannels: ['whatsapp'],
        relationshipScore: 22,
        daysSinceContact: 120,
        apollo: { location: 'London, United Kingdom', headline: 'CEO at Acme' },
    }),
    cold: makeContact({
        id: 'c_003',
        name: 'Carol Cold',
        phones: [],
        emails: ['carol@example.com'],
        sources: { whatsapp: null, linkedin: { name: 'Carol Cold', company: 'TechCorp', position: 'Founder & CTO' }, telegram: null, email: null, googleContacts: null, sms: null },
        lastContactedAt: null,
        interactionCount: 0,
        activeChannels: [],
        relationshipScore: 0,
        daysSinceContact: null,
        apollo: { location: 'New York, NY, United States', headline: 'Founder & CTO at TechCorp' },
    }),
    group: makeContact({
        id: 'c_004',
        name: 'Acme Group Chat',
        phones: [],
        emails: [],
        isGroup: true,
        sources: { whatsapp: { id: 'acmegroup@g.us' }, linkedin: null, telegram: null, email: null, googleContacts: null, sms: null },
        relationshipScore: 0,
    }),
};

// Sample interactions for CONTACTS.strong
const INTERACTIONS = [
    makeInteraction({ id: 'i_001', chatId: '447911555001@c.us', timestamp: '2026-01-15T10:00:00.000Z', body: 'Coffee next week?' }),
    makeInteraction({ id: 'i_002', chatId: '447911555001@c.us', timestamp: '2026-01-16T11:00:00.000Z', from: 'me', to: '+447911555001', body: 'Sure! Thursday works.' }),
    makeInteraction({ id: 'i_003', source: 'email', chatId: 'alice@example.com', timestamp: '2025-11-01T09:00:00.000Z', body: 'Following up on our meeting...' }),
];

module.exports = { makeContact, makeInteraction, CONTACTS, INTERACTIONS };

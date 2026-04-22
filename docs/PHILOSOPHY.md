# Minty — Research: Personal Relationship Management
# What it should be, who it's for, what actually matters.

---

## The Core Problem

Most people have far more network than they use.

You have hundreds of connections — investors, operators, engineers, founders, people at every
company you'd ever want to work with or sell to. But when you need something specific, you
either ask the same 5 people you always ask, or you go in cold.

The gap isn't the size of your network. It's your ability to activate it strategically.

**Minty's purpose:** Help you achieve your goals and dreams through the network you already have.

Not "stay in touch with everyone." Not "keep relationships warm." Those are means, not ends.
The end is: when you need something — a fundraise, a hire, a market entry, an introduction,
an opportunity — you know exactly who to talk to and how to reach them.

**The insight no other tool has acted on:**
You already have the data. Every message you've sent is evidence of a relationship. WhatsApp,
email, LinkedIn, SMS — collectively they hold the entire history. Minty unifies that history
and makes your network queryable: "who in my network can help me with X right now?"

**What this means for the product:**
- Relationship scores matter because they tell you how accessible someone is — not as health metrics
- Dormancy only matters if the dormant person is relevant to a current goal
- The primary interaction is not "reach out to these people" — it's "I need X, who can help?"
- Features that push the user to speak to more people for maintenance's sake are wrong

---

## User Personas

### Persona 1: The Connector — "Marcus"
**Who:** 34. Works in venture capital or business development. London/NYC/SF.
Has 3,000+ LinkedIn connections and sends ~50 messages a day across platforms.
Relationships are his product. Every introduction has potential business value.

**Pain:**
- Keeps warm relationships across too many people to track manually
- Loses context between conversations ("what did we talk about last time?")
- Doesn't know which relationships are quietly dying
- Introduction opportunities slip through because he can't pattern-match at scale

**What he needs from Minty:**
- Morning brief: "3 strong relationships you haven't touched in 60+ days"
- Instant recall: before any meeting, "here's what you talked about last time + any open threads"
- Intro radar: "You know both sides of this — you should make this intro"
- Relationship heat map: which companies/sectors in his network are strong vs cold

**His "gasp" moment:** He opens Minty before a coffee meeting and gets a brief that reads like
an EA prepared it — last 3 conversation threads, her current role change, an open loop from 6 months ago.

---

### Persona 2: The Founder — "Priya"
**Who:** 29. Building her second startup. Pre-seed. Network is her most valuable asset.
She has 800 contacts but needs specific things: investors, enterprise buyers, senior engineers.

**Pain:**
- Hard to remember which investors she talked to and what their status was
- Needs warm intros but doesn't know who's best positioned to make them
- Time is extremely scarce — can't spend time on relationship maintenance
- Her existing CRM (HubSpot) is overkill and feels transactional

**What she needs from Minty:**
- "Who do I know who can intro me to a16z?" — answer in seconds
- Track last touchpoint with every investor so nothing goes cold mid-raise
- Smart reconnect: "Sarah from your MBA cohort is now a Partner at Index. Last contact: 14 months."
- Weekly 10-minute review: who to nurture, who to thank, who to meet

**Her "gasp" moment:** Minty surfaces that a warm intro path exists to a top investor she'd been
trying to reach cold — through someone she went to university with.

---

### Persona 3: The Executive — "James"
**Who:** 47. CFO at a mid-size company. Has a high-value but small network (~400 real relationships).
Values depth over breadth. Doesn't have time to manage a CRM; doesn't want to.

**Pain:**
- Loses context between infrequent touchpoints with important people
- People fall off his radar and he only notices when he needs them
- Has no system — currently uses mental models and email search
- Doesn't want to log calls manually

**What he needs from Minty:**
- Zero-maintenance: data comes in automatically (email, calendar, LinkedIn)
- "Who haven't I spoken to in 3 months who I should?" — weekly nudge
- Pre-meeting brief from calendar: tomorrow he has a call with X, Minty auto-preps
- Simple, not overwhelming — he wants insight not busywork

**His "gasp" moment:** He gets a Sunday evening brief: "You have a call with David on Tuesday.
Last time you spoke (8 months ago), he mentioned his company was looking to expand into Europe.
Here's what you discussed." He feels like he has a personal assistant.

---

### Persona 4: The Career Builder — "Aisha"
**Who:** 26. Software engineer. 2 years in. Building a network deliberately for the first time.
Has ~200 LinkedIn connections, mostly from university and current company. Active on WhatsApp.

**Pain:**
- Doesn't know how to maintain a network without it feeling fake/transactional
- Loses touch with university friends who are now at interesting companies
- Doesn't know which of her connections could actually help her vs just being connected
- Feels awkward reaching out after long gaps — doesn't know what to say

**What she needs from Minty:**
- Warm prompts: "It's been 6 months since you spoke with Ravi. He's now at Google DeepMind."
- Context for reconnecting: "Last time you talked, you were both working on ML projects at uni"
- Low-pressure reminders, not urgent alarms
- Help writing a reconnect message that doesn't feel generic

**Her "gasp" moment:** Minty shows her that 3 of her close uni friends now work at companies
she's been trying to get into — and suggests she reach out with specific context for each.

---

## Feature Prioritization: Solve Real Problems Extremely Well

> **The filter for every feature:** Does this help the user achieve a specific goal through
> their network? If it just tells them to talk to more people, cut it.

### Tier 0: The Foundation (must be right or nothing else matters)

**Continuous, automatic data sync**
Every persona assumes the data is current. If the data is stale, all insights are wrong.
This is non-negotiable. The sync daemon needs to work silently in the background.

- WhatsApp: persistent whatsapp-web.js client → real-time event listener → auto-merge
- Email: Gmail API incremental sync (historyId) → poll every 10 min
- File-based sources (LinkedIn, Telegram, SMS): file watchers → auto-import on change
- Google Contacts: People API syncToken → poll every 30 min
- Status visible in UI: "Last synced 3 min ago" per source

---

### Tier 1: The Core Loop (1 problem solved extremely well)

**Problem: "I know the right person exists in my network — I just can't find them fast enough."**

This is the one thing Minty should solve better than anything else on earth.

1. **Goals-first home view** — The moment you open Minty: "What are you working on?"
   User states a current goal or project. Minty surfaces the people in their network
   most relevant to that goal — not "who you haven't spoken to," but "who can move the needle."

2. **Natural language network query** — "Who do I know in fintech who could intro me to Monzo?"
   "Who in my network has raised a Series A?" "Who do I know at Google who works on AI?"
   This is the primary interaction. Everything else supports it.

3. **Rich contact context** — When you find the right person, you immediately know everything
   relevant: last conversation, what you talked about, open threads, their current role.
   Minty makes every outreach feel warm and informed, not cold and awkward.

---

### Tier 2: High Leverage (multiplies the core loop)

4. **Calendar meeting prep** — You're meeting someone. Minty shows you everything relevant
   before you walk in. Not "maintain this relationship" — "be maximally effective in this meeting."

5. **Introduction path finding** — "I need to reach X. Who's my warmest path in?"
   Multi-hop graph traversal through your network. Shows the chain: you → Alice → X.

6. **Opportunity signals from communities** — WhatsApp groups and LinkedIn communities surface
   hiring signals, event announcements, funding news. Relevant to your goals, not noise.

---

### Tier 3: Depth and Delight (makes power users love it)

7. **Proactive goal matching** — When Minty detects someone in your network is newly relevant
   to a goal (new role, new company, shared context), it surfaces them. Not "reach out" —
   "this person just became relevant to what you're working on."

8. **Relationship warmth as access signal** — Score tells you: "can I ask this person for a
   favour?" High score = warm enough to ask for intro. Low score = might need warming up first.
   Framing is strategic, not maintenance-oriented.

9. **Group/community signals** — What's happening that's relevant to your goals right now.

---

### Deliberately Out of Scope

- Social media tracking (Twitter, Instagram follows)
- Contact enrichment from third-party databases (paid)
- Team/shared CRM (multiple users sharing one relationship graph)
- Outreach automation / bulk messaging
- Any feature that makes Minty feel like a sales tool

---

## The Jony Ive Design Mandate

**Design principle #1: One clear thing at a time.**
Every view has one primary action. The home view says "reach out to these people."
The contact view says "here's everything you need to know about this person."
Don't show everything at once. Lead the user to the right action.

**Design principle #2: The data disappears, the relationship remains.**
The interface should feel warm, human, relational — not analytical or database-y.
No tables. No dense data grids. Lead with the person's face. Lead with their name large.

**Design principle #3: Earn every pixel.**
Every element on screen should be there because it helps the user understand or act.
If it's decoration for decoration's sake, remove it. If it's data that doesn't change behavior,
remove it or move it behind a tap.

**Design principle #4: Time is the primary dimension.**
Relationships change over time. Everything should be expressed in temporal terms:
"3 days ago", "2 months of silence", "Known since 2019." Not raw dates.

**Design principle #5: Delight in the details.**
The hover. The transition. The tap feedback. These are not extras — they're what makes
the product feel alive vs dead. 200ms ease transitions. Subtle shadows on hover.
Score rings that animate when you open a contact. These are the moments people remember.

**Specific changes:**
- Navigation: collapse to 5 items with icons only (labels as tooltips) — less chrome, more space
- Contact cards: avatar is the hero, not the name. Large avatar with relationship health ring.
- Typography: tight letter-spacing on names (-0.02em), all-caps small-caps for company names
- Color: single green-to-red spectrum for relationship health. Purple only for interactive elements.
- Home view: big, generous. Not a dashboard. A calm morning briefing.
- Transitions: every view change slides or fades. No jarring state switches.
- Empty states: warm, human, instructive. Not "No data found."

---

## What Success Looks Like

A user opens Minty when they need something — a fundraise, a hire, an introduction,
a market they want to enter — and within 60 seconds they:
1. Know exactly who in their network can help
2. Know how warm that connection is and what they last talked about
3. Have enough context to reach out in a way that feels personal, not cold

That's the whole product. Everything else is in service of that moment.

**The user does NOT open Minty to maintain relationships.**
They open Minty when they have a goal and need to activate their network to achieve it.

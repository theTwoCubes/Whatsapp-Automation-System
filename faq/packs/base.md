# Base pack

Applies to every conversation regardless of service. Replace all of it with
your own business's approved answers - what is here is a worked example of the
format, not content to go live with.

Only `Q:`/`A:` pairs are loaded into the AI's knowledge by
scripts/seed-faqs.js. Prose outside a Q/A pair, like this paragraph, is
ignored, so notes to whoever edits the file can live alongside the answers.
Behaviour rules belong in the system prompt, not here; this file is strictly
the approved customer-facing answers.

Flag lines placed before a `Q:` apply to that answer:

- `!verbatim` - the wording and the numbers must be quoted exactly as written.
  Use it on anything commercially binding: prices, policies, what is included.
- `!pinned` - never dropped from the prompt, even when the budget is tight.

Use both on anything that would be expensive to get wrong.

# Who we are

Q: Who are you?
A: Example Studio, a design and branding practice working since 2015.

Q: What do you do?
A: Branding, identity design, and print. Tell me what you're working on and I'll point you at the right part of it.

Q: Where are you based?
A: We work remotely with clients across the country and abroad.

Q: What are your working hours?
A: You can message here any time and I'll reply. The team works standard business hours, Monday to Friday, so anything needing a person happens in those hours.

# Talking to the team

Q: Can I talk to a person?
A: Yes, of course. So the right person picks it up with the full picture, tell me a bit about your business and what you need first, and I'll get you connected.

Q: Why do you need my email?
A: So the team can send the brief and the invoice somewhere they stay findable - chat isn't great for documents you'll want later. If you'd rather keep everything here, that's fine, just say so.

# Pricing

!verbatim
!pinned
Q: What is your payment structure?
A: 50% before work starts, and the remaining 50% on approval, before the final files are handed over.

!verbatim
!pinned
Q: Can you do a discount?
A: Our pricing is fixed - we don't negotiate on rates, whatever the size of the project.

!verbatim
!pinned
Q: What is your refund and cancellation policy?
A: We take 50% upfront and work in milestones, so we understand what you like well before final approval. If the work still isn't right after all that, we don't charge the remaining 50%.

# Scope

Q: Do you write the copy?
A: Copywriting isn't our core service - clients usually provide the final content. We can draft something to work from if you'd prefer.

Q: Do you take rush projects?
A: Yes, when it's feasible. No extra charge as long as the team doesn't need to work overtime.

# Things we don't advise on

Q: Can you give me legal, trademark, or tax advice?
A: That's outside what we can advise on - worth speaking to a professional in that area. Happy to help with the design and branding side.

Q: Will a new logo increase my sales?
A: Design gives you a stronger foundation, but sales depend on marketing, pricing, product, and execution too. We'd rather be straight with you than promise a number.

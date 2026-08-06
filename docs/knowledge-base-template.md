# Knowledge base template

The bot answers only from this sheet. If a fact is not here, it will not make
one up. It will say a team member will confirm. So keep this sheet current.

## How it is read

n8n reads the sheet as CSV. The simplest setup is:

1. Put the content in a Google Sheet.
2. File, Share, Publish to web.
3. Choose the specific sheet/tab and the CSV format.
4. Copy the published URL into `KNOWLEDGE_BASE_CSV_URL` in `.env`.

The published CSV is read-only to us and editable by you. No API key needed.

## Columns

Use exactly these column headers in the first row. Order does not matter, spelling does.

| Column | Meaning | Example |
|---|---|---|
| service_key | Short code that ties a row to a service. Use `general` for rows that apply to everything. Must match the `service_key` used in the campaigns table. | `logo_design` |
| service_name | Human name of the service. | Logo Design |
| price_text | The exact price wording the bot is allowed to quote. If blank, the bot will not quote a price and will offer to have someone confirm. | Starts at 4,999 for 3 concepts |
| turnaround | Delivery time. | 3 to 5 working days |
| description | One or two lines about what is included. | Includes 3 concepts, 2 revisions, final files in PNG and SVG. |
| faq_question | A common question. Optional. | Do you provide the source file? |
| faq_answer | The answer to that question. | Yes, you get the editable source file on final delivery. |

## Rules that matter

- The bot quotes prices only from `price_text`. Never rely on it to calculate or
  guess a price. If you do not want it quoting a number, leave `price_text` empty.
- One service can have several rows (one per FAQ). Repeat the `service_key` and
  `service_name`, fill a different `faq_question` and `faq_answer` each time.
- Rows with `service_key = general` are always included, whatever the customer asked about.
  Good for things like working hours, revision policy, or file formats.
- Keep answers short and factual. The bot rewrites them into WhatsApp style, but
  it cannot fix a wrong fact.

## Example rows

| service_key | service_name | price_text | turnaround | description | faq_question | faq_answer |
|---|---|---|---|---|---|---|
| logo_design | Logo Design | Starts at 4,999 for 3 concepts | 3 to 5 working days | 3 concepts, 2 revisions, PNG and SVG on delivery |  |  |
| logo_design | Logo Design |  |  |  | Do I get the source file? | Yes, the editable source file is shared on final delivery. |
| branding | Branding Package | Starts at 14,999 | 7 to 10 working days | Logo, colour palette, fonts, and a basic brand sheet |  |  |
| general |  |  |  |  | What are your working hours? | We reply between 10am and 7pm, Monday to Saturday. |

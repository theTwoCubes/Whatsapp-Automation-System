import React, { useEffect, useState } from 'react';
import { api } from '../../api.js';
import Button from '../../components/ui/Button.jsx';
import { InputField } from '../../components/ui/Field.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { useToast } from '../../components/ui/Toast.jsx';
import {
  AdminPage, Section, Card, CardHeader, CardBody,
  FormStack, FormActions, TabPills,
} from './Dashboard.jsx';

// Business Profile
function BusinessProfile() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    api.getProfile().then((d) => {
      setData(d);
      const p = d.profile || {};
      setForm({
        about:       p.about       || '',
        description: p.description || '',
        email:       p.email       || '',
        address:     p.address     || '',
        vertical:    p.vertical    || '',
        websites:    (p.websites || []).join(', '),
      });
    }).catch(() => {});
  }, []);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await api.saveProfile({
        ...form,
        websites: form.websites ? form.websites.split(',').map((s) => s.trim()).filter(Boolean) : [],
      });
      toast.success('Business profile saved - changes go live on WhatsApp within a few minutes');
    } catch (e) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  if (!data) return (
    <FormStack>
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i}>
          <Skeleton height={12} width="30%" style={{ marginBottom: 6 }} />
          <Skeleton height={36} />
        </div>
      ))}
    </FormStack>
  );

  return (
    <Section
      title="WhatsApp business profile"
      subtitle="Shown on your WhatsApp business profile."
    >
      <Card>
        <CardBody>
        <FormStack>
          <InputField label="About" placeholder="e.g. Helping brands stand out with great design."
            value={form.about} onChange={(e) => setForm({ ...form, about: e.target.value })} />
          <InputField label="Description" textarea
            placeholder="We're a creative studio specialising in brand identity, logo design, and digital marketing."
            value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <InputField label="Business email" placeholder="hello@yourbusiness.com"
            value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <InputField label="Address" placeholder="123 Main St, City, Country"
            value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          <InputField label="Websites" textarea rows={2}
            helper="Comma separated."
            placeholder="https://yourbusiness.com, https://instagram.com/yourbusiness"
            value={form.websites} onChange={(e) => setForm({ ...form, websites: e.target.value })} />
          <FormActions>
            <Button variant="primary" size="sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save profile'}</Button>
          </FormActions>
        </FormStack>
      </CardBody>
      </Card>
    </Section>
  );
}

// AI Behaviour
function AIBehaviour() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    api.getSettings().then((d) => { setData(d); setForm(d.settings || {}); }).catch(() => {});
  }, []);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await api.saveSettings({
        business_name:       form.business_name,
        business_about:      form.business_about,
        business_tone:       form.business_tone,
        bot_name:            form.bot_name,
        fallback_message:    form.fallback_message,
        handoff_message:     form.handoff_message,
        opt_out_message:     form.opt_out_message,
        resume_minutes:      form.resume_minutes,
        website_url:         form.website_url,
        contact_phone:       form.contact_phone,
        support_email:       form.support_email,
        instagram_url:       form.instagram_url,
      });
      toast.success('Settings saved - the AI will use these in its next conversation');
    } catch (e) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  if (!data) return (
    <FormStack>
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i}>
          <Skeleton height={12} width="30%" style={{ marginBottom: 6 }} />
          <Skeleton height={36} />
        </div>
      ))}
    </FormStack>
  );

  const bind = (key) => ({
    value: form[key] ?? '',
    onChange: (e) => setForm({ ...form, [key]: e.target.value }),
  });

  return (
    <div className="flex flex-col gap-8">
      <Section title="How the AI describes your business">
        <Card>
          <CardBody>
          <FormStack>
            <InputField label="Business name"
              placeholder="Acme Studio"
              {...bind('business_name')} />
            <InputField label="AI's name"
              placeholder="Adi"
              {...bind('bot_name')} />
            <InputField label="About the business" textarea
              placeholder="We're a full-service creative agency specialising in brand identity, logo design, and marketing."
              {...bind('business_about')} />
            <InputField label="Tone of voice"
              placeholder="Friendly and professional. Warm but concise. No slang."
              {...bind('business_tone')} />
          </FormStack>
          </CardBody>
        </Card>
      </Section>

      <Section title="Contact details the AI can share">
        <Card>
          <CardBody>
          <FormStack>
            <InputField label="Website"
              placeholder="https://yourbusiness.com"
              {...bind('website_url')} />
            <InputField label="Phone number"
              placeholder="+91 98765 43210"
              {...bind('contact_phone')} />
            <InputField label="Email"
              placeholder="hello@yourbusiness.com"
              {...bind('support_email')} />
            <InputField label="Instagram"
              placeholder="https://instagram.com/yourbusiness"
              {...bind('instagram_url')} />
          </FormStack>
          </CardBody>
        </Card>
      </Section>

      <Section title="What the AI says at key moments">
        <Card>
          <CardBody>
          <FormStack>
            <InputField label="When the AI is stuck" textarea
              placeholder="That's a great question - let me check with the team and get right back to you."
              {...bind('fallback_message')} />
            <InputField label="When passing the chat to a person" textarea
              placeholder="Someone from our team will be with you shortly. Thanks for your patience!"
              {...bind('handoff_message')} />
            <InputField label="When a customer asks to stop getting messages" textarea
              placeholder="Understood, you won't receive further messages from us. Reply anytime if you need help."
              {...bind('opt_out_message')} />
          </FormStack>
          </CardBody>
        </Card>
      </Section>

      <Section title="When the AI takes back over">
        <Card>
          <CardBody>
          <FormStack>
            <InputField label="Hand the chat back to the AI after"
              helper="Minutes of silence. 0 keeps it with the team."
              type="number"
              min={0}
              placeholder="0"
              style={{ maxWidth: 200 }}
              {...bind('resume_minutes')} />
          </FormStack>
        </CardBody>
      </Card>
      </Section>

      <div className="flex items-center justify-end">
        <Button variant="primary" size="sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</Button>
      </div>
    </div>
  );
}

// Setup Page
export default function Setup() {
  const [section, setSection] = useState('ai');

  return (
    <AdminPage
      title="Setup"
      subtitle="AI voice, rules, and your WhatsApp business profile."
    >
      <TabPills
        tabs={[
          { key: 'ai',      label: 'AI voice & rules' },
          { key: 'profile', label: 'WhatsApp profile' },
        ]}
        active={section}
        onChange={setSection}
      />
      {section === 'ai'      && <AIBehaviour />}
      {section === 'profile' && <BusinessProfile />}
    </AdminPage>
  );
}

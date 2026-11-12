-- Restore catalog defaults for runner tools installed before action permissions were supported.
UPDATE agent_tools AS a SET unasked = defaults.unasked
FROM tools AS t, (VALUES
('gmail-runner', '["search_emails","read_email","get_thread","list_inbox_threads","get_inbox_with_threads","list_email_labels","draft_email"]'::jsonb),
('microsoft-365', '["list-mail-folder-messages","list-mail-messages","get-mail-message","read-mail-text","list-mail-attachments","create-reply-draft"]'::jsonb)
) AS defaults(catalog_id, unasked)
WHERE a.tool_id = t.id AND t.kind = 'runner' AND t.catalog_id = defaults.catalog_id AND a.unasked = '[]'::jsonb;

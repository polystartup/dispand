-- Stem keeps the business in the workspace memory: existing Stems that never had a learning target get `workspace`, once.
UPDATE agents SET self_learning = '["workspace"]'::jsonb WHERE built_in = 'assistant' AND self_learning = '[]'::jsonb;

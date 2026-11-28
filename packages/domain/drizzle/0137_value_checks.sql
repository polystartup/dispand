-- A check on every text column with a set of values (its list in schema.ts), and the slot invariants of
-- step_runs. NOT VALID: the rows already there aren't scanned, so an install holding a value no release
-- wrote still boots; every insert and update is checked from now on. No released version wrote a value
-- outside these lists to a row that remains (0044 rewrote event_fires' 'chain-limit'). A later release
-- can VALIDATE CONSTRAINT each of them (#658).
ALTER TABLE "agents" ADD CONSTRAINT "agents_built_in_check" CHECK ("agents"."built_in" in ('assistant')) NOT VALID;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_format_check" CHECK ("artifacts"."format" in ('html', 'svg')) NOT VALID;--> statement-breakpoint
ALTER TABLE "audit" ADD CONSTRAINT "audit_action_check" CHECK ("audit"."action" in ('job.created', 'job.queued', 'job.started', 'job.grantIssued', 'job.paused', 'job.turn', 'job.turnInterrupt', 'job.reopened', 'job.waiting', 'job.finished', 'job.failed', 'job.skipped', 'checkpoint.reached', 'checkpoint.answered', 'question.asked', 'question.answered', 'question.awaitingConsent', 'question.consented', 'question.expired', 'question.refused', 'question.rerouted', 'question.unanswered', 'consult.asked', 'consult.ended', 'platform.call', 'tool.call', 'poll.run', 'poll.itemRetried', 'event.recorded', 'memory.written', 'plugin.decided', 'plugin.nativeGranted', 'plugin.nativeApproved', 'workspace.created', 'workspace.renamed', 'workspace.runnerRegistered', 'workspace.runnerRevoked', 'workspace.subscriptionEnrolled', 'workspace.subscriptionEnded', 'workspace.memberRemoved', 'workspace.memberAssigned', 'workspace.organizationMemberRemoved', 'workspace.ownershipTransferred', 'workspace.personArchived', 'workspace.personPurged', 'workspace.personRestored', 'workspace.retentionChanged', 'workspace.invited', 'workspace.invitationRevoked', 'workspace.invitationAccepted', 'profile.updated')) NOT VALID;--> statement-breakpoint
ALTER TABLE "audit" ADD CONSTRAINT "audit_resource_type_check" CHECK ("audit"."resource_type" in ('job', 'root', 'question', 'consult', 'tool', 'trigger', 'poll', 'table', 'row', 'field', 'agent', 'harness', 'proposal', 'plugin', 'marketplace', 'memory', 'artifact', 'workspace', 'user')) NOT VALID;--> statement-breakpoint
ALTER TABLE "audit" ADD CONSTRAINT "audit_result_check" CHECK ("audit"."result" in ('ok', 'refused', 'failed')) NOT VALID;--> statement-breakpoint
ALTER TABLE "chat_queue" ADD CONSTRAINT "chat_queue_state_check" CHECK ("chat_queue"."state" in ('pending', 'steering', 'dispatched', 'failed', 'removed')) NOT VALID;--> statement-breakpoint
ALTER TABLE "cloud_sessions" ADD CONSTRAINT "cloud_sessions_status_check" CHECK ("cloud_sessions"."status" in ('running', 'waiting', 'idle', 'done')) NOT VALID;--> statement-breakpoint
ALTER TABLE "event_fires" ADD CONSTRAINT "event_fires_status_check" CHECK ("event_fires"."status" in ('started', 'deferred', 'skipped-same-agent', 'out-of-scope', 'refused', 'stopped')) NOT VALID;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_operation_check" CHECK ("events"."operation" in ('created', 'updated', 'deleted', 'answered', 'expired', 'finished', 'failed')) NOT VALID;--> statement-breakpoint
ALTER TABLE "fields" ADD CONSTRAINT "fields_type_check" CHECK ("fields"."type" in ('text', 'long-text', 'number', 'checkbox', 'date', 'url', 'attachment', 'single-select', 'reference')) NOT VALID;--> statement-breakpoint
ALTER TABLE "harnesses" ADD CONSTRAINT "harnesses_type_check" CHECK ("harnesses"."type" in ('cli', 'cloud')) NOT VALID;--> statement-breakpoint
ALTER TABLE "harnesses" ADD CONSTRAINT "harnesses_kind_check" CHECK ("harnesses"."kind" in ('claude-code', 'codex', 'anthropic', 'openai', 'openai-compatible')) NOT VALID;--> statement-breakpoint
ALTER TABLE "harnesses" ADD CONSTRAINT "harnesses_permission_mode_check" CHECK ("harnesses"."permission_mode" in ('default', 'acceptEdits', 'plan', 'bypassPermissions')) NOT VALID;--> statement-breakpoint
ALTER TABLE "harnesses" ADD CONSTRAINT "harnesses_effort_check" CHECK ("harnesses"."effort" in ('low', 'medium', 'high')) NOT VALID;--> statement-breakpoint
ALTER TABLE "marketplaces" ADD CONSTRAINT "marketplaces_kind_check" CHECK ("marketplaces"."kind" in ('marketplace', 'skill-repo', 'well-known')) NOT VALID;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_type_check" CHECK ("memories"."type" in ('business', 'practice', 'fact', 'reference')) NOT VALID;--> statement-breakpoint
ALTER TABLE "memory_revisions" ADD CONSTRAINT "memory_revisions_type_check" CHECK ("memory_revisions"."type" in ('business', 'practice', 'fact', 'reference')) NOT VALID;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_role_check" CHECK ("messages"."role" in ('assistant', 'user', 'tool')) NOT VALID;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_kind_check" CHECK ("pages"."kind" in ('home', 'page')) NOT VALID;--> statement-breakpoint
ALTER TABLE "plugin_conflicts" ADD CONSTRAINT "plugin_conflicts_kind_check" CHECK ("plugin_conflicts"."kind" in ('agent', 'tool', 'trigger', 'table', 'skill_file')) NOT VALID;--> statement-breakpoint
ALTER TABLE "plugin_conflicts" ADD CONSTRAINT "plugin_conflicts_status_check" CHECK ("plugin_conflicts"."status" in ('stem', 'approval', 'open')) NOT VALID;--> statement-breakpoint
ALTER TABLE "plugins" ADD CONSTRAINT "plugins_source_check" CHECK ("plugins"."source" in ('marketplace', 'generated')) NOT VALID;--> statement-breakpoint
ALTER TABLE "plugins" ADD CONSTRAINT "plugins_layout_check" CHECK ("plugins"."layout" in ('claude', 'standard')) NOT VALID;--> statement-breakpoint
ALTER TABLE "poll_items" ADD CONSTRAINT "poll_items_status_check" CHECK ("poll_items"."status" in ('baseline', 'started', 'deferred', 'out-of-scope', 'refused')) NOT VALID;--> statement-breakpoint
ALTER TABLE "polls" ADD CONSTRAINT "polls_status_check" CHECK ("polls"."status" in ('calling', 'baseline', 'polled', 'skipped', 'failed')) NOT VALID;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_status_check" CHECK ("proposals"."status" in ('draft', 'asked', 'approved', 'declined')) NOT VALID;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_language_check" CHECK ("push_subscriptions"."language" in ('en', 'fr')) NOT VALID;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_placement_check" CHECK ("questions"."placement" in ('chat', 'notifications')) NOT VALID;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_kind_check" CHECK ("questions"."kind" in ('question', 'approval', 'consult')) NOT VALID;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_status_check" CHECK ("questions"."status" in ('pending', 'answered', 'expired')) NOT VALID;--> statement-breakpoint
ALTER TABLE "roots" ADD CONSTRAINT "roots_kind_check" CHECK ("roots"."kind" in ('user', 'chat', 'schedule', 'event', 'poll')) NOT VALID;--> statement-breakpoint
ALTER TABLE "roots" ADD CONSTRAINT "roots_state_check" CHECK ("roots"."state" in ('going', 'paused', 'stopped')) NOT VALID;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_source_check" CHECK ("runs"."source" in ('workflow', 'agent')) NOT VALID;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_status_check" CHECK ("runs"."status" in ('running', 'waiting', 'succeeded', 'failed')) NOT VALID;--> statement-breakpoint
ALTER TABLE "schedule_fires" ADD CONSTRAINT "schedule_fires_status_check" CHECK ("schedule_fires"."status" in ('started', 'skipped-overlap', 'refused')) NOT VALID;--> statement-breakpoint
ALTER TABLE "step_runs" ADD CONSTRAINT "step_runs_status_check" CHECK ("step_runs"."status" in ('pending', 'running', 'waiting', 'succeeded', 'failed', 'skipped')) NOT VALID;--> statement-breakpoint
ALTER TABLE "step_runs" ADD CONSTRAINT "step_runs_turn_status_check" CHECK ("step_runs"."turn_status" in ('unknown', 'idle', 'running')) NOT VALID;--> statement-breakpoint
ALTER TABLE "step_runs" ADD CONSTRAINT "step_runs_queue_class_check" CHECK ("step_runs"."queue_class" in ('person', 'resume', 'new')) NOT VALID;--> statement-breakpoint
ALTER TABLE "step_runs" ADD CONSTRAINT "step_runs_working_not_queued" CHECK (not ("step_runs"."working" and "step_runs"."queued_at" is not null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "step_runs" ADD CONSTRAINT "step_runs_queued_with_class" CHECK (("step_runs"."queued_at" is null) = ("step_runs"."queue_class" is null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "subscription_enrollments" ADD CONSTRAINT "subscription_enrollments_harness_check" CHECK ("subscription_enrollments"."harness" in ('claude-code', 'codex')) NOT VALID;--> statement-breakpoint
ALTER TABLE "tools" ADD CONSTRAINT "tools_kind_check" CHECK ("tools"."kind" in ('http', 'runner')) NOT VALID;--> statement-breakpoint
ALTER TABLE "tools" ADD CONSTRAINT "tools_transport_check" CHECK ("tools"."transport" in ('streamable-http', 'sse')) NOT VALID;--> statement-breakpoint
ALTER TABLE "tools" ADD CONSTRAINT "tools_auth_check" CHECK ("tools"."auth" in ('none', 'headers', 'oauth')) NOT VALID;--> statement-breakpoint
ALTER TABLE "tools" ADD CONSTRAINT "tools_oauth_status_check" CHECK ("tools"."oauth_status" in ('authorize', 'connected', 'reauthorize')) NOT VALID;--> statement-breakpoint
ALTER TABLE "trigger_fires" ADD CONSTRAINT "trigger_fires_status_check" CHECK ("trigger_fires"."status" in ('started', 'skipped-overlap', 'refused')) NOT VALID;--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_kind_check" CHECK ("triggers"."kind" in ('manual', 'schedule', 'primitive', 'poll')) NOT VALID;--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_concurrency_check" CHECK ("triggers"."concurrency" in ('parallel', 'one-at-a-time')) NOT VALID;--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_built_in_check" CHECK ("triggers"."built_in" in ('review')) NOT VALID;
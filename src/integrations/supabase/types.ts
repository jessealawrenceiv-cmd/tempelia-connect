export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      activity_log_filter_rejections: {
        Row: {
          blocked: boolean
          created_at: string
          id: string
          issue_fields: string[]
          issues: Json
          raw_filters: Json
          source: string
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          blocked?: boolean
          created_at?: string
          id?: string
          issue_fields?: string[]
          issues?: Json
          raw_filters?: Json
          source: string
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          blocked?: boolean
          created_at?: string
          id?: string
          issue_fields?: string[]
          issues?: Json
          raw_filters?: Json
          source?: string
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      admin_access_log: {
        Row: {
          actor_user_id: string
          created_at: string
          detail: string | null
          function_name: string
          id: string
          occurred_at: string
          outcome: string
          row_count: number | null
        }
        Insert: {
          actor_user_id: string
          created_at?: string
          detail?: string | null
          function_name: string
          id?: string
          occurred_at?: string
          outcome?: string
          row_count?: number | null
        }
        Update: {
          actor_user_id?: string
          created_at?: string
          detail?: string | null
          function_name?: string
          id?: string
          occurred_at?: string
          outcome?: string
          row_count?: number | null
        }
        Relationships: []
      }
      appointments: {
        Row: {
          created_at: string
          customer_id: string | null
          date: string
          duration_minutes: number
          id: string
          intake_submission_id: string | null
          notes: string | null
          quote_id: string | null
          time: string | null
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          customer_id?: string | null
          date: string
          duration_minutes?: number
          id?: string
          intake_submission_id?: string | null
          notes?: string | null
          quote_id?: string | null
          time?: string | null
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          customer_id?: string | null
          date?: string
          duration_minutes?: number
          id?: string
          intake_submission_id?: string | null
          notes?: string | null
          quote_id?: string | null
          time?: string | null
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "appointments_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_intake_submission_id_fkey"
            columns: ["intake_submission_id"]
            isOneToOne: false
            referencedRelation: "intake_submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
        ]
      }
      contact_import_events: {
        Row: {
          actor_user_id: string | null
          attestation_accepted_at: string
          attestation_text: string
          column_mapping: Json
          created_at: string
          file_name: string | null
          id: string
          imported_count: number
          occurred_at: string
          skipped_count: number
          skipped_reasons: Json
          total_rows: number
          updated_count: number
          user_id: string
        }
        Insert: {
          actor_user_id?: string | null
          attestation_accepted_at?: string
          attestation_text: string
          column_mapping?: Json
          created_at?: string
          file_name?: string | null
          id?: string
          imported_count?: number
          occurred_at?: string
          skipped_count?: number
          skipped_reasons?: Json
          total_rows?: number
          updated_count?: number
          user_id: string
        }
        Update: {
          actor_user_id?: string | null
          attestation_accepted_at?: string
          attestation_text?: string
          column_mapping?: Json
          created_at?: string
          file_name?: string | null
          id?: string
          imported_count?: number
          occurred_at?: string
          skipped_count?: number
          skipped_reasons?: Json
          total_rows?: number
          updated_count?: number
          user_id?: string
        }
        Relationships: []
      }
      customers: {
        Row: {
          consent_form_signed: boolean
          consent_form_signed_at: string | null
          created_at: string
          email: string | null
          first_name: string
          id: string
          last_name: string | null
          last_reactivation_at: string | null
          last_service_date: string | null
          notes: string | null
          opt_in_consent: boolean
          phone_number: string
          sms_opt_in_at: string | null
          source: string
          updated_at: string
          user_id: string
        }
        Insert: {
          consent_form_signed?: boolean
          consent_form_signed_at?: string | null
          created_at?: string
          email?: string | null
          first_name?: string
          id?: string
          last_name?: string | null
          last_reactivation_at?: string | null
          last_service_date?: string | null
          notes?: string | null
          opt_in_consent?: boolean
          phone_number: string
          sms_opt_in_at?: string | null
          source?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          consent_form_signed?: boolean
          consent_form_signed_at?: string | null
          created_at?: string
          email?: string | null
          first_name?: string
          id?: string
          last_name?: string | null
          last_reactivation_at?: string | null
          last_service_date?: string | null
          notes?: string | null
          opt_in_consent?: boolean
          phone_number?: string
          sms_opt_in_at?: string | null
          source?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      debug_log_cleanup_runs: {
        Row: {
          created_at: string
          debug_deleted_count: number
          id: string
          ran_at: string
          recovery_deleted_count: number
        }
        Insert: {
          created_at?: string
          debug_deleted_count?: number
          id?: string
          ran_at?: string
          recovery_deleted_count?: number
        }
        Update: {
          created_at?: string
          debug_deleted_count?: number
          id?: string
          ran_at?: string
          recovery_deleted_count?: number
        }
        Relationships: []
      }
      deposit_jump_debug_events: {
        Row: {
          correlation_id: string | null
          created_at: string
          event_name: string
          id: string
          occurred_at: string
          payload: Json
          quote_id: string | null
          user_id: string
        }
        Insert: {
          correlation_id?: string | null
          created_at?: string
          event_name: string
          id?: string
          occurred_at?: string
          payload?: Json
          quote_id?: string | null
          user_id: string
        }
        Update: {
          correlation_id?: string | null
          created_at?: string
          event_name?: string
          id?: string
          occurred_at?: string
          payload?: Json
          quote_id?: string | null
          user_id?: string
        }
        Relationships: []
      }
      deposit_jump_recovery_events: {
        Row: {
          action: string
          attempt_index: number | null
          correlation_id: string | null
          created_at: string
          event_id: string | null
          id: string
          ms_since_first_miss: number | null
          ms_since_miss: number | null
          occurred_at: string
          quote_id: string | null
          reason: string | null
          user_id: string
        }
        Insert: {
          action: string
          attempt_index?: number | null
          correlation_id?: string | null
          created_at?: string
          event_id?: string | null
          id?: string
          ms_since_first_miss?: number | null
          ms_since_miss?: number | null
          occurred_at?: string
          quote_id?: string | null
          reason?: string | null
          user_id: string
        }
        Update: {
          action?: string
          attempt_index?: number | null
          correlation_id?: string | null
          created_at?: string
          event_id?: string | null
          id?: string
          ms_since_first_miss?: number | null
          ms_since_miss?: number | null
          occurred_at?: string
          quote_id?: string | null
          reason?: string | null
          user_id?: string
        }
        Relationships: []
      }
      excluded_numbers: {
        Row: {
          created_at: string
          id: string
          label: string | null
          phone_number: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          label?: string | null
          phone_number: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          label?: string | null
          phone_number?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      home_quote_dismissals: {
        Row: {
          business_owner_id: string
          created_at: string
          dismissed_by: string | null
          dismissed_decline_reason: string | null
          dismissed_status: string
          id: string
          quote_id: string
          updated_at: string
        }
        Insert: {
          business_owner_id: string
          created_at?: string
          dismissed_by?: string | null
          dismissed_decline_reason?: string | null
          dismissed_status: string
          id?: string
          quote_id: string
          updated_at?: string
        }
        Update: {
          business_owner_id?: string
          created_at?: string
          dismissed_by?: string | null
          dismissed_decline_reason?: string | null
          dismissed_status?: string
          id?: string
          quote_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "home_quote_dismissals_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: true
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
        ]
      }
      intake_rate_limits: {
        Row: {
          id: string
          ip_hash: string
          submitted_at: string
          user_id: string
        }
        Insert: {
          id?: string
          ip_hash: string
          submitted_at?: string
          user_id: string
        }
        Update: {
          id?: string
          ip_hash?: string
          submitted_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "intake_rate_limits_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      intake_submissions: {
        Row: {
          created_at: string
          customer_business_name: string | null
          customer_email: string | null
          customer_first_name: string
          customer_id: string | null
          customer_last_name: string
          customer_phone: string
          id: string
          photo_urls: string[]
          responses: Json
          source: string
          status: string
          submitted_at: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          customer_business_name?: string | null
          customer_email?: string | null
          customer_first_name: string
          customer_id?: string | null
          customer_last_name: string
          customer_phone: string
          id?: string
          photo_urls?: string[]
          responses?: Json
          source?: string
          status?: string
          submitted_at?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          customer_business_name?: string | null
          customer_email?: string | null
          customer_first_name?: string
          customer_id?: string | null
          customer_last_name?: string
          customer_phone?: string
          id?: string
          photo_urls?: string[]
          responses?: Json
          source?: string
          status?: string
          submitted_at?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "intake_submissions_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      integrations: {
        Row: {
          created_at: string
          google_review_url: string | null
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          google_review_url?: string | null
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          google_review_url?: string | null
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      invite_cleanup_runs: {
        Row: {
          created_at: string
          deleted_count: number
          id: string
          ran_at: string
        }
        Insert: {
          created_at?: string
          deleted_count?: number
          id?: string
          ran_at?: string
        }
        Update: {
          created_at?: string
          deleted_count?: number
          id?: string
          ran_at?: string
        }
        Relationships: []
      }
      invoice_counters: {
        Row: {
          created_at: string
          next_seq: number
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          next_seq?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          next_seq?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      invoices: {
        Row: {
          archived_at: string | null
          balance_due: number | null
          balance_paid_at: string | null
          created_at: string
          customer_business_name: string | null
          customer_email: string | null
          customer_first_name: string
          customer_id: string | null
          customer_last_name: string | null
          customer_phone: string
          deposit_amount: number
          deposit_paid: boolean
          id: string
          invoice_number: string
          invoice_seq: number
          job_site_address: string
          last_sms_sent_at: string | null
          line_items: Json
          quote_id: string | null
          sent_at: string | null
          status: string
          subtotal: number
          superseded_by_id: string | null
          tax_amount: number
          tax_rate: number
          total_amount: number
          updated_at: string
          user_id: string
        }
        Insert: {
          archived_at?: string | null
          balance_due?: number | null
          balance_paid_at?: string | null
          created_at?: string
          customer_business_name?: string | null
          customer_email?: string | null
          customer_first_name: string
          customer_id?: string | null
          customer_last_name?: string | null
          customer_phone: string
          deposit_amount?: number
          deposit_paid?: boolean
          id?: string
          invoice_number: string
          invoice_seq: number
          job_site_address: string
          last_sms_sent_at?: string | null
          line_items?: Json
          quote_id?: string | null
          sent_at?: string | null
          status?: string
          subtotal?: number
          superseded_by_id?: string | null
          tax_amount?: number
          tax_rate?: number
          total_amount?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          archived_at?: string | null
          balance_due?: number | null
          balance_paid_at?: string | null
          created_at?: string
          customer_business_name?: string | null
          customer_email?: string | null
          customer_first_name?: string
          customer_id?: string | null
          customer_last_name?: string | null
          customer_phone?: string
          deposit_amount?: number
          deposit_paid?: boolean
          id?: string
          invoice_number?: string
          invoice_seq?: number
          job_site_address?: string
          last_sms_sent_at?: string | null
          line_items?: Json
          quote_id?: string | null
          sent_at?: string | null
          status?: string
          subtotal?: number
          superseded_by_id?: string | null
          tax_amount?: number
          tax_rate?: number
          total_amount?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoices_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_superseded_by_id_fkey"
            columns: ["superseded_by_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      jobs: {
        Row: {
          completed_at: string | null
          created_at: string
          customer_id: string | null
          id: string
          intake_submission_id: string | null
          job_value: number | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          customer_id?: string | null
          id?: string
          intake_submission_id?: string | null
          job_value?: number | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          customer_id?: string | null
          id?: string
          intake_submission_id?: string | null
          job_value?: number | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "jobs_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_intake_submission_id_fkey"
            columns: ["intake_submission_id"]
            isOneToOne: false
            referencedRelation: "intake_submissions"
            referencedColumns: ["id"]
          },
        ]
      }
      log_action_type_drift_runs: {
        Row: {
          actor_user_id: string
          constraint_name: string
          created_at: string
          db_values: string[]
          detail: string | null
          generated_values: string[]
          id: string
          matched: boolean
          ran_at: string
        }
        Insert: {
          actor_user_id: string
          constraint_name: string
          created_at?: string
          db_values: string[]
          detail?: string | null
          generated_values: string[]
          id?: string
          matched: boolean
          ran_at?: string
        }
        Update: {
          actor_user_id?: string
          constraint_name?: string
          created_at?: string
          db_values?: string[]
          detail?: string | null
          generated_values?: string[]
          id?: string
          matched?: boolean
          ran_at?: string
        }
        Relationships: []
      }
      log_reconciliation_runs: {
        Row: {
          created_at: string
          detail: string | null
          duration_ms: number
          id: string
          missed_call_inserted: number
          provisioned_inserted: number
          ran_at: string
          sms_inbound_inserted: number
        }
        Insert: {
          created_at?: string
          detail?: string | null
          duration_ms?: number
          id?: string
          missed_call_inserted?: number
          provisioned_inserted?: number
          ran_at?: string
          sms_inbound_inserted?: number
        }
        Update: {
          created_at?: string
          detail?: string | null
          duration_ms?: number
          id?: string
          missed_call_inserted?: number
          provisioned_inserted?: number
          ran_at?: string
          sms_inbound_inserted?: number
        }
        Relationships: []
      }
      log_retention_runs: {
        Row: {
          archived_age_count: number
          archived_cap_count: number
          created_at: string
          id: string
          purged_archive_count: number
          ran_at: string
        }
        Insert: {
          archived_age_count?: number
          archived_cap_count?: number
          created_at?: string
          id?: string
          purged_archive_count?: number
          ran_at?: string
        }
        Update: {
          archived_age_count?: number
          archived_cap_count?: number
          created_at?: string
          id?: string
          purged_archive_count?: number
          ran_at?: string
        }
        Relationships: []
      }
      log_write_rejections: {
        Row: {
          actor_user_id: string | null
          attempted_row: Json
          blocked_at: string
          constraint_name: string | null
          correlation_id: string | null
          created_at: string
          error_code: string | null
          error_message: string | null
          id: string
          occurred_at: string
          rejected_action_type: string | null
          rejected_action_types: string[]
          request_path: string | null
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          actor_user_id?: string | null
          attempted_row?: Json
          blocked_at?: string
          constraint_name?: string | null
          correlation_id?: string | null
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          occurred_at?: string
          rejected_action_type?: string | null
          rejected_action_types?: string[]
          request_path?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          actor_user_id?: string | null
          attempted_row?: Json
          blocked_at?: string
          constraint_name?: string | null
          correlation_id?: string | null
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          occurred_at?: string
          rejected_action_type?: string | null
          rejected_action_types?: string[]
          request_path?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      logs: {
        Row: {
          action_type: string
          call_sid: string | null
          created_at: string
          customer_id: string | null
          id: string
          message_sent: string | null
          prompt_cooldown_minutes: number | null
          prompt_template: string | null
          prompt_template_hash: string | null
          recipient_phone: string | null
          recording_sid: string | null
          status: string
          twilio_message_sid: string | null
          user_id: string
          voicemail_url: string | null
        }
        Insert: {
          action_type: string
          call_sid?: string | null
          created_at?: string
          customer_id?: string | null
          id?: string
          message_sent?: string | null
          prompt_cooldown_minutes?: number | null
          prompt_template?: string | null
          prompt_template_hash?: string | null
          recipient_phone?: string | null
          recording_sid?: string | null
          status?: string
          twilio_message_sid?: string | null
          user_id: string
          voicemail_url?: string | null
        }
        Update: {
          action_type?: string
          call_sid?: string | null
          created_at?: string
          customer_id?: string | null
          id?: string
          message_sent?: string | null
          prompt_cooldown_minutes?: number | null
          prompt_template?: string | null
          prompt_template_hash?: string | null
          recipient_phone?: string | null
          recording_sid?: string | null
          status?: string
          twilio_message_sid?: string | null
          user_id?: string
          voicemail_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "logs_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      logs_archive: {
        Row: {
          action_type: string
          archive_reason: string
          archived_at: string
          call_sid: string | null
          created_at: string
          customer_id: string | null
          id: string
          message_sent: string | null
          original_created_at: string
          prompt_cooldown_minutes: number | null
          prompt_template: string | null
          prompt_template_hash: string | null
          recipient_phone: string | null
          recording_sid: string | null
          status: string
          twilio_message_sid: string | null
          user_id: string
          voicemail_url: string | null
        }
        Insert: {
          action_type: string
          archive_reason?: string
          archived_at?: string
          call_sid?: string | null
          created_at?: string
          customer_id?: string | null
          id: string
          message_sent?: string | null
          original_created_at: string
          prompt_cooldown_minutes?: number | null
          prompt_template?: string | null
          prompt_template_hash?: string | null
          recipient_phone?: string | null
          recording_sid?: string | null
          status: string
          twilio_message_sid?: string | null
          user_id: string
          voicemail_url?: string | null
        }
        Update: {
          action_type?: string
          archive_reason?: string
          archived_at?: string
          call_sid?: string | null
          created_at?: string
          customer_id?: string | null
          id?: string
          message_sent?: string | null
          original_created_at?: string
          prompt_cooldown_minutes?: number | null
          prompt_template?: string | null
          prompt_template_hash?: string | null
          recipient_phone?: string | null
          recording_sid?: string | null
          status?: string
          twilio_message_sid?: string | null
          user_id?: string
          voicemail_url?: string | null
        }
        Relationships: []
      }
      mcp_rate_limits: {
        Row: {
          called_at: string
          id: string
          tool_name: string
          user_id: string
        }
        Insert: {
          called_at?: string
          id?: string
          tool_name: string
          user_id: string
        }
        Update: {
          called_at?: string
          id?: string
          tool_name?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          allow_deposit_override_per_quote: boolean
          auto_refresh_enabled: boolean
          auto_refresh_interval_minutes: number
          business_name: string
          created_at: string
          decline_followup_mode: string
          default_deposit_fixed_amount: number | null
          default_deposit_type: string
          email: string | null
          id: string
          intake_enabled: boolean
          last_test_phone: string | null
          opt_in_prompt_cooldown_minutes: number
          opt_in_prompt_template: string | null
          owner_phone: string | null
          platform_fee_percent: number
          review_requests_enabled: boolean
          stripe_connect_account_id: string | null
          stripe_connect_connected_at: string | null
          stripe_connect_status: string
          stripe_customer_id: string | null
          subscription_status: string
          subscription_tier: string
          tos_accepted_at: string | null
          twilio_phone_number: string | null
          twilio_phone_sid: string | null
          twilio_provisioned_at: string | null
          updated_at: string
          voicemail_enabled: boolean
          zip_code: string | null
        }
        Insert: {
          allow_deposit_override_per_quote?: boolean
          auto_refresh_enabled?: boolean
          auto_refresh_interval_minutes?: number
          business_name?: string
          created_at?: string
          decline_followup_mode?: string
          default_deposit_fixed_amount?: number | null
          default_deposit_type?: string
          email?: string | null
          id: string
          intake_enabled?: boolean
          last_test_phone?: string | null
          opt_in_prompt_cooldown_minutes?: number
          opt_in_prompt_template?: string | null
          owner_phone?: string | null
          platform_fee_percent?: number
          review_requests_enabled?: boolean
          stripe_connect_account_id?: string | null
          stripe_connect_connected_at?: string | null
          stripe_connect_status?: string
          stripe_customer_id?: string | null
          subscription_status?: string
          subscription_tier?: string
          tos_accepted_at?: string | null
          twilio_phone_number?: string | null
          twilio_phone_sid?: string | null
          twilio_provisioned_at?: string | null
          updated_at?: string
          voicemail_enabled?: boolean
          zip_code?: string | null
        }
        Update: {
          allow_deposit_override_per_quote?: boolean
          auto_refresh_enabled?: boolean
          auto_refresh_interval_minutes?: number
          business_name?: string
          created_at?: string
          decline_followup_mode?: string
          default_deposit_fixed_amount?: number | null
          default_deposit_type?: string
          email?: string | null
          id?: string
          intake_enabled?: boolean
          last_test_phone?: string | null
          opt_in_prompt_cooldown_minutes?: number
          opt_in_prompt_template?: string | null
          owner_phone?: string | null
          platform_fee_percent?: number
          review_requests_enabled?: boolean
          stripe_connect_account_id?: string | null
          stripe_connect_connected_at?: string | null
          stripe_connect_status?: string
          stripe_customer_id?: string | null
          subscription_status?: string
          subscription_tier?: string
          tos_accepted_at?: string | null
          twilio_phone_number?: string | null
          twilio_phone_sid?: string | null
          twilio_provisioned_at?: string | null
          updated_at?: string
          voicemail_enabled?: boolean
          zip_code?: string | null
        }
        Relationships: []
      }
      quotes: {
        Row: {
          archived_at: string | null
          billing_address: string | null
          created_at: string
          customer_business_name: string | null
          customer_first_name: string
          customer_id: string | null
          customer_last_name: string | null
          customer_phone: string
          decline_followup_sent_at: string | null
          decline_reason: string | null
          deposit_amount: number
          deposit_custom_type: string | null
          deposit_custom_value: number | null
          deposit_paid: boolean
          deposit_paid_at: string | null
          deposit_required: boolean
          deposit_selection: string
          description: string | null
          id: string
          job_site_address: string
          job_type: string
          last_sms_sent_at: string | null
          line_items: Json
          po_number: string | null
          responded_at: string | null
          status: string
          subtotal: number
          superseded_by_id: string | null
          tax_amount: number
          tax_exempt: boolean
          tax_rate: number
          total_amount: number
          updated_at: string
          user_id: string
          valid_until: string | null
        }
        Insert: {
          archived_at?: string | null
          billing_address?: string | null
          created_at?: string
          customer_business_name?: string | null
          customer_first_name: string
          customer_id?: string | null
          customer_last_name?: string | null
          customer_phone: string
          decline_followup_sent_at?: string | null
          decline_reason?: string | null
          deposit_amount?: number
          deposit_custom_type?: string | null
          deposit_custom_value?: number | null
          deposit_paid?: boolean
          deposit_paid_at?: string | null
          deposit_required?: boolean
          deposit_selection?: string
          description?: string | null
          id?: string
          job_site_address: string
          job_type?: string
          last_sms_sent_at?: string | null
          line_items?: Json
          po_number?: string | null
          responded_at?: string | null
          status?: string
          subtotal?: number
          superseded_by_id?: string | null
          tax_amount?: number
          tax_exempt?: boolean
          tax_rate?: number
          total_amount?: number
          updated_at?: string
          user_id: string
          valid_until?: string | null
        }
        Update: {
          archived_at?: string | null
          billing_address?: string | null
          created_at?: string
          customer_business_name?: string | null
          customer_first_name?: string
          customer_id?: string | null
          customer_last_name?: string | null
          customer_phone?: string
          decline_followup_sent_at?: string | null
          decline_reason?: string | null
          deposit_amount?: number
          deposit_custom_type?: string | null
          deposit_custom_value?: number | null
          deposit_paid?: boolean
          deposit_paid_at?: string | null
          deposit_required?: boolean
          deposit_selection?: string
          description?: string | null
          id?: string
          job_site_address?: string
          job_type?: string
          last_sms_sent_at?: string | null
          line_items?: Json
          po_number?: string | null
          responded_at?: string | null
          status?: string
          subtotal?: number
          superseded_by_id?: string | null
          tax_amount?: number
          tax_exempt?: boolean
          tax_rate?: number
          total_amount?: number
          updated_at?: string
          user_id?: string
          valid_until?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "quotes_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_superseded_by_id_fkey"
            columns: ["superseded_by_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_consent_events: {
        Row: {
          action: string
          created_at: string
          customer_id: string | null
          id: string
          keyword: string
          message_body: string | null
          occurred_at: string
          phone_number: string
          twilio_message_sid: string | null
          user_id: string
        }
        Insert: {
          action: string
          created_at?: string
          customer_id?: string | null
          id?: string
          keyword: string
          message_body?: string | null
          occurred_at?: string
          phone_number: string
          twilio_message_sid?: string | null
          user_id: string
        }
        Update: {
          action?: string
          created_at?: string
          customer_id?: string | null
          id?: string
          keyword?: string
          message_body?: string | null
          occurred_at?: string
          phone_number?: string
          twilio_message_sid?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sms_consent_events_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      status_refresh_locks: {
        Row: {
          created_at: string
          last_finished_at: string | null
          last_result: string | null
          locked_at: string | null
          released_at: string | null
          run_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          last_finished_at?: string | null
          last_result?: string | null
          locked_at?: string | null
          released_at?: string | null
          run_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          last_finished_at?: string | null
          last_result?: string | null
          locked_at?: string | null
          released_at?: string | null
          run_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      subscriptions: {
        Row: {
          cancel_at_period_end: boolean | null
          created_at: string | null
          current_period_end: string | null
          current_period_start: string | null
          environment: string
          id: string
          price_id: string
          product_id: string
          status: string
          stripe_customer_id: string
          stripe_subscription_id: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          cancel_at_period_end?: boolean | null
          created_at?: string | null
          current_period_end?: string | null
          current_period_start?: string | null
          environment?: string
          id?: string
          price_id: string
          product_id: string
          status?: string
          stripe_customer_id: string
          stripe_subscription_id: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          cancel_at_period_end?: boolean | null
          created_at?: string | null
          current_period_end?: string | null
          current_period_start?: string | null
          environment?: string
          id?: string
          price_id?: string
          product_id?: string
          status?: string
          stripe_customer_id?: string
          stripe_subscription_id?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      team_invite_events: {
        Row: {
          actor_user_id: string | null
          business_owner_id: string
          created_at: string
          detail: string | null
          event_type: string
          id: string
          invited_email: string
          occurred_at: string
          team_member_id: string | null
        }
        Insert: {
          actor_user_id?: string | null
          business_owner_id: string
          created_at?: string
          detail?: string | null
          event_type: string
          id?: string
          invited_email: string
          occurred_at?: string
          team_member_id?: string | null
        }
        Update: {
          actor_user_id?: string | null
          business_owner_id?: string
          created_at?: string
          detail?: string | null
          event_type?: string
          id?: string
          invited_email?: string
          occurred_at?: string
          team_member_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "team_invite_events_team_member_id_fkey"
            columns: ["team_member_id"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
        ]
      }
      team_members: {
        Row: {
          accepted_at: string | null
          business_owner_id: string
          created_at: string
          expires_at: string
          id: string
          invited_at: string
          invited_email: string
          role: string
          staff_user_id: string | null
          updated_at: string
        }
        Insert: {
          accepted_at?: string | null
          business_owner_id: string
          created_at?: string
          expires_at?: string
          id?: string
          invited_at?: string
          invited_email: string
          role?: string
          staff_user_id?: string | null
          updated_at?: string
        }
        Update: {
          accepted_at?: string | null
          business_owner_id?: string
          created_at?: string
          expires_at?: string
          id?: string
          invited_at?: string
          invited_email?: string
          role?: string
          staff_user_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      webhook_correlation_runs: {
        Row: {
          correlated_count: number
          created_at: string
          duration_ms: number
          id: string
          missing_count: number
          not_applicable_count: number
          ran_at: string
        }
        Insert: {
          correlated_count?: number
          created_at?: string
          duration_ms?: number
          id?: string
          missing_count?: number
          not_applicable_count?: number
          ran_at?: string
        }
        Update: {
          correlated_count?: number
          created_at?: string
          duration_ms?: number
          id?: string
          missing_count?: number
          not_applicable_count?: number
          ran_at?: string
        }
        Relationships: []
      }
      webhook_deliveries: {
        Row: {
          attempt_count: number
          completed_at: string | null
          created_at: string
          delivery_key: string
          event_kind: string
          first_seen_at: string
          id: string
          last_seen_at: string
          response_body: string | null
          response_content_type: string | null
          response_status: number | null
          source: string
          state: string
          user_id: string | null
        }
        Insert: {
          attempt_count?: number
          completed_at?: string | null
          created_at?: string
          delivery_key: string
          event_kind: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          response_body?: string | null
          response_content_type?: string | null
          response_status?: number | null
          source: string
          state?: string
          user_id?: string | null
        }
        Update: {
          attempt_count?: number
          completed_at?: string | null
          created_at?: string
          delivery_key?: string
          event_kind?: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          response_body?: string | null
          response_content_type?: string | null
          response_status?: number | null
          source?: string
          state?: string
          user_id?: string | null
        }
        Relationships: []
      }
      webhook_events: {
        Row: {
          correlated_at: string | null
          correlated_log_id: string | null
          correlation_detail: string | null
          correlation_state: string
          created_at: string
          event_kind: string
          from_number: string | null
          id: string
          payload: Json
          received_at: string
          request_path: string | null
          signature_detail: string | null
          signature_valid: boolean
          source: string
          to_number: string | null
          user_id: string | null
        }
        Insert: {
          correlated_at?: string | null
          correlated_log_id?: string | null
          correlation_detail?: string | null
          correlation_state?: string
          created_at?: string
          event_kind: string
          from_number?: string | null
          id?: string
          payload?: Json
          received_at?: string
          request_path?: string | null
          signature_detail?: string | null
          signature_valid?: boolean
          source: string
          to_number?: string | null
          user_id?: string | null
        }
        Update: {
          correlated_at?: string | null
          correlated_log_id?: string | null
          correlation_detail?: string | null
          correlation_state?: string
          created_at?: string
          event_kind?: string
          from_number?: string | null
          id?: string
          payload?: Json
          received_at?: string
          request_path?: string | null
          signature_detail?: string | null
          signature_valid?: boolean
          source?: string
          to_number?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "webhook_events_correlated_log_id_fkey"
            columns: ["correlated_log_id"]
            isOneToOne: false
            referencedRelation: "logs"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      admin_access_log_prune: { Args: never; Returns: undefined }
      archive_old_logs: {
        Args: {
          _archive_max_age?: string
          _keep_per_user?: number
          _max_age?: string
        }
        Returns: number
      }
      claim_team_invite: { Args: { _invite_id: string }; Returns: boolean }
      claim_team_invites: { Args: never; Returns: number }
      cleanup_deposit_jump_debug_events: {
        Args: { _max_age?: string; _max_per_user?: number }
        Returns: number
      }
      cleanup_expired_team_invites: { Args: never; Returns: number }
      flag_missed_call_correlation_failures: {
        Args: { _grace?: string }
        Returns: {
          correlated_count: number
          missing_count: number
          not_applicable_count: number
        }[]
      }
      has_active_subscription: {
        Args: { check_env?: string; user_uuid: string }
        Returns: boolean
      }
      has_expired_team_invite: { Args: never; Returns: boolean }
      has_pending_team_invite: { Args: never; Returns: boolean }
      has_role: {
        Args: { _role: Database["public"]["Enums"]["app_role"] }
        Returns: boolean
      }
      is_accepted_team_member: { Args: { _owner_id: string }; Returns: boolean }
      list_pending_team_invites: {
        Args: never
        Returns: {
          business_name: string
          business_owner_id: string
          expires_at: string
          invite_id: string
          invited_at: string
        }[]
      }
      log_reconciliation_runs_prune: { Args: never; Returns: undefined }
      log_write_rejections_prune: { Args: never; Returns: undefined }
      logs_action_type_whitelist: {
        Args: never
        Returns: {
          allowed_values: string[]
          constraint_def: string
          constraint_name: string
        }[]
      }
      mcp_rate_limits_prune: { Args: never; Returns: undefined }
      reconcile_activity_logs: {
        Args: never
        Returns: {
          missed_call_inserted: number
          provisioned_inserted: number
          sms_inbound_inserted: number
        }[]
      }
      resolve_deposit_amount: {
        Args: {
          _custom_type: string
          _custom_value: number
          _default_fixed: number
          _default_type: string
          _selection: string
          _total: number
        }
        Returns: number
      }
      status_refresh_release: {
        Args: { _result?: string; _run_id: string }
        Returns: boolean
      }
      status_refresh_try_lock: {
        Args: { _ttl_seconds?: number }
        Returns: string
      }
      team_seat_usage: {
        Args: never
        Returns: {
          seat_limit: number
          seats_remaining: number
          seats_used: number
          tier: string
        }[]
      }
      tier_seat_limit: { Args: { _tier: string }; Returns: number }
      webhook_correlation_runs_prune: { Args: never; Returns: undefined }
      webhook_deliveries_prune: { Args: never; Returns: undefined }
      webhook_delivery_claim: {
        Args: { _delivery_key: string; _event_kind: string; _source: string }
        Returns: {
          attempt_count: number
          delivery_id: string
          is_duplicate: boolean
          response_body: string
          response_content_type: string
          response_status: number
          state: string
        }[]
      }
      webhook_delivery_complete: {
        Args: {
          _delivery_id: string
          _response_body: string
          _response_content_type: string
          _response_status: number
          _state: string
          _user_id: string
        }
        Returns: undefined
      }
      webhook_events_prune: { Args: never; Returns: undefined }
    }
    Enums: {
      app_role: "admin" | "user"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "user"],
    },
  },
} as const

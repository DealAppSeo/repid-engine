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
    PostgrestVersion: "12.2.3 (519615d)"
  }
  public: {
    Tables: {
      _temp_ext: {
        Row: {
          extname: string | null
          extversion: string | null
          id: number
        }
        Insert: {
          extname?: string | null
          extversion?: string | null
          id?: number
        }
        Update: {
          extname?: string | null
          extversion?: string | null
          id?: number
        }
        Relationships: []
      }
      _temp_rls: {
        Row: {
          cmd: string | null
          id: number
          polname: string | null
          qual: string | null
          withcheck: string | null
        }
        Insert: {
          cmd?: string | null
          id?: number
          polname?: string | null
          qual?: string | null
          withcheck?: string | null
        }
        Update: {
          cmd?: string | null
          id?: number
          polname?: string | null
          qual?: string | null
          withcheck?: string | null
        }
        Relationships: []
      }
      _temp_sig: {
        Row: {
          id: number
          sig: string | null
        }
        Insert: {
          id?: number
          sig?: string | null
        }
        Update: {
          id?: number
          sig?: string | null
        }
        Relationships: []
      }
      _temp_triggers: {
        Row: {
          def: string | null
          id: number
          proname: string | null
          prosrc: string | null
          tgname: string | null
        }
        Insert: {
          def?: string | null
          id?: number
          proname?: string | null
          prosrc?: string | null
          tgname?: string | null
        }
        Update: {
          def?: string | null
          id?: number
          proname?: string | null
          prosrc?: string | null
          tgname?: string | null
        }
        Relationships: []
      }
      accountability_tiers: {
        Row: {
          created_at: string | null
          grace_window_hours: number | null
          id: number
          liability_flavor: string
          max_slash_events_90d: number
          min_constitutional_refusals: number
          min_days_active: number
          min_repid_to_act: number
          min_verified_trades: number
          plain_english_description: string
          repid_at_risk_max_pts: number | null
          repid_at_risk_pct: number
          requires_audited_entity: boolean | null
          requires_sbt: boolean | null
          slash_rules: Json | null
          tier_code: string
          tier_level: number
          tier_name: string
          ui_color: string
          ui_label: string
          who_can_act: string
          who_can_be_backed: string
          yield_rate: number | null
          zkp_circuit: string
        }
        Insert: {
          created_at?: string | null
          grace_window_hours?: number | null
          id?: never
          liability_flavor: string
          max_slash_events_90d: number
          min_constitutional_refusals: number
          min_days_active: number
          min_repid_to_act: number
          min_verified_trades: number
          plain_english_description: string
          repid_at_risk_max_pts?: number | null
          repid_at_risk_pct: number
          requires_audited_entity?: boolean | null
          requires_sbt?: boolean | null
          slash_rules?: Json | null
          tier_code: string
          tier_level: number
          tier_name: string
          ui_color: string
          ui_label: string
          who_can_act: string
          who_can_be_backed: string
          yield_rate?: number | null
          zkp_circuit: string
        }
        Update: {
          created_at?: string | null
          grace_window_hours?: number | null
          id?: never
          liability_flavor?: string
          max_slash_events_90d?: number
          min_constitutional_refusals?: number
          min_days_active?: number
          min_repid_to_act?: number
          min_verified_trades?: number
          plain_english_description?: string
          repid_at_risk_max_pts?: number | null
          repid_at_risk_pct?: number
          requires_audited_entity?: boolean | null
          requires_sbt?: boolean | null
          slash_rules?: Json | null
          tier_code?: string
          tier_level?: number
          tier_name?: string
          ui_color?: string
          ui_label?: string
          who_can_act?: string
          who_can_be_backed?: string
          yield_rate?: number | null
          zkp_circuit?: string
        }
        Relationships: []
      }
      achievements: {
        Row: {
          achievement_type: string
          credits_earned: number | null
          description: string | null
          earned_at: string
          id: string
          metadata: Json | null
          title: string
          user_id: string
        }
        Insert: {
          achievement_type: string
          credits_earned?: number | null
          description?: string | null
          earned_at?: string
          id?: string
          metadata?: Json | null
          title: string
          user_id: string
        }
        Update: {
          achievement_type?: string
          credits_earned?: number | null
          description?: string | null
          earned_at?: string
          id?: string
          metadata?: Json | null
          title?: string
          user_id?: string
        }
        Relationships: []
      }
      agent_a2a_cards: {
        Row: {
          agent_card: Json
          agent_name: string
          id: number
          last_updated: string | null
          token_id: string
        }
        Insert: {
          agent_card: Json
          agent_name: string
          id?: number
          last_updated?: string | null
          token_id: string
        }
        Update: {
          agent_card?: Json
          agent_name?: string
          id?: number
          last_updated?: string | null
          token_id?: string
        }
        Relationships: []
      }
      agent_accuracy_matrix: {
        Row: {
          accuracy_rate: number | null
          agent_id: string
          anfis_weight_current: number | null
          asset: string | null
          avg_confidence_when_correct: number | null
          avg_confidence_when_wrong: number | null
          calibration_score: number | null
          correct_predictions: number | null
          id: number
          last_weight_update: string | null
          modality: string | null
          observations: number | null
          regime_type: string | null
          updated_at: string | null
        }
        Insert: {
          accuracy_rate?: number | null
          agent_id: string
          anfis_weight_current?: number | null
          asset?: string | null
          avg_confidence_when_correct?: number | null
          avg_confidence_when_wrong?: number | null
          calibration_score?: number | null
          correct_predictions?: number | null
          id?: number
          last_weight_update?: string | null
          modality?: string | null
          observations?: number | null
          regime_type?: string | null
          updated_at?: string | null
        }
        Update: {
          accuracy_rate?: number | null
          agent_id?: string
          anfis_weight_current?: number | null
          asset?: string | null
          avg_confidence_when_correct?: number | null
          avg_confidence_when_wrong?: number | null
          calibration_score?: number | null
          correct_predictions?: number | null
          id?: number
          last_weight_update?: string | null
          modality?: string | null
          observations?: number | null
          regime_type?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      agent_activity_log: {
        Row: {
          action: string
          agent_name: string
          created_at: string | null
          evidence_type: string | null
          id: number
          task_id: number | null
          verifiable_evidence: Json | null
        }
        Insert: {
          action: string
          agent_name: string
          created_at?: string | null
          evidence_type?: string | null
          id?: number
          task_id?: number | null
          verifiable_evidence?: Json | null
        }
        Update: {
          action?: string
          agent_name?: string
          created_at?: string | null
          evidence_type?: string | null
          id?: number
          task_id?: number | null
          verifiable_evidence?: Json | null
        }
        Relationships: []
      }
      agent_api_keys: {
        Row: {
          agent_id: string | null
          created_at: string | null
          id: string
          key_hash: string
          key_prefix: string
          last_used_at: string | null
          name: string | null
          revoked_at: string | null
          scopes: string[] | null
        }
        Insert: {
          agent_id?: string | null
          created_at?: string | null
          id?: string
          key_hash: string
          key_prefix: string
          last_used_at?: string | null
          name?: string | null
          revoked_at?: string | null
          scopes?: string[] | null
        }
        Update: {
          agent_id?: string | null
          created_at?: string | null
          id?: string
          key_hash?: string
          key_prefix?: string
          last_used_at?: string | null
          name?: string | null
          revoked_at?: string | null
          scopes?: string[] | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_api_keys_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_artifacts: {
        Row: {
          agent_id: string
          content: string | null
          content_hash: string | null
          created_at: string
          embedding: string | null
          id: number
          node_type: string
          sprint_id: number
          zk_weight: number | null
        }
        Insert: {
          agent_id: string
          content?: string | null
          content_hash?: string | null
          created_at?: string
          embedding?: string | null
          id?: number
          node_type: string
          sprint_id: number
          zk_weight?: number | null
        }
        Update: {
          agent_id?: string
          content?: string | null
          content_hash?: string | null
          created_at?: string
          embedding?: string | null
          id?: number
          node_type?: string
          sprint_id?: number
          zk_weight?: number | null
        }
        Relationships: []
      }
      agent_artifacts_sprint_0: {
        Row: {
          agent_id: string
          content: string | null
          content_hash: string | null
          created_at: string
          embedding: string | null
          id: number
          node_type: string
          sprint_id: number
          zk_weight: number | null
        }
        Insert: {
          agent_id: string
          content?: string | null
          content_hash?: string | null
          created_at?: string
          embedding?: string | null
          id?: number
          node_type: string
          sprint_id: number
          zk_weight?: number | null
        }
        Update: {
          agent_id?: string
          content?: string | null
          content_hash?: string | null
          created_at?: string
          embedding?: string | null
          id?: number
          node_type?: string
          sprint_id?: number
          zk_weight?: number | null
        }
        Relationships: []
      }
      agent_capability_scores: {
        Row: {
          agent_id: string
          capability_score: number | null
          correct_secondary: number | null
          id: number
          last_contribution_at: string | null
          modality: string
          observations: number | null
          secondary_eligible: boolean | null
          updated_at: string | null
        }
        Insert: {
          agent_id: string
          capability_score?: number | null
          correct_secondary?: number | null
          id?: number
          last_contribution_at?: string | null
          modality: string
          observations?: number | null
          secondary_eligible?: boolean | null
          updated_at?: string | null
        }
        Update: {
          agent_id?: string
          capability_score?: number | null
          correct_secondary?: number | null
          id?: number
          last_contribution_at?: string | null
          modality?: string
          observations?: number | null
          secondary_eligible?: boolean | null
          updated_at?: string | null
        }
        Relationships: []
      }
      agent_character_history: {
        Row: {
          agent_id: string
          character_after: number
          context: Json | null
          created_at: string
          delta: number
          event_type: string
          id: string
        }
        Insert: {
          agent_id: string
          character_after: number
          context?: Json | null
          created_at?: string
          delta: number
          event_type: string
          id?: string
        }
        Update: {
          agent_id?: string
          character_after?: number
          context?: Json | null
          created_at?: string
          delta?: number
          event_type?: string
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_character_history_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_context_protocol: {
        Row: {
          context_text: string
          created_at: string | null
          id: string
          version: string | null
        }
        Insert: {
          context_text: string
          created_at?: string | null
          id?: string
          version?: string | null
        }
        Update: {
          context_text?: string
          created_at?: string | null
          id?: string
          version?: string | null
        }
        Relationships: []
      }
      agent_custodianship_links: {
        Row: {
          agent_dbt_id: number
          capabilities: Json | null
          capabilities_hash: string
          expires_at: number
          human_address: string
          id: string
          linked_at: string | null
          nonce: number
          signature: string
          status: string
        }
        Insert: {
          agent_dbt_id: number
          capabilities?: Json | null
          capabilities_hash: string
          expires_at: number
          human_address: string
          id?: string
          linked_at?: string | null
          nonce: number
          signature: string
          status?: string
        }
        Update: {
          agent_dbt_id?: number
          capabilities?: Json | null
          capabilities_hash?: string
          expires_at?: number
          human_address?: string
          id?: string
          linked_at?: string | null
          nonce?: number
          signature?: string
          status?: string
        }
        Relationships: []
      }
      agent_directives: {
        Row: {
          activated_at: string | null
          conductor_id: string | null
          consensus_threshold: number | null
          created_at: string | null
          directive_data: Json
          directive_type: string
          effective_from: string | null
          effective_until: string | null
          id: number
          issued_by: string
          issued_repid: number
          requires_consensus: boolean | null
          revoked_at: string | null
          revoked_by: string | null
          status: string | null
        }
        Insert: {
          activated_at?: string | null
          conductor_id?: string | null
          consensus_threshold?: number | null
          created_at?: string | null
          directive_data: Json
          directive_type: string
          effective_from?: string | null
          effective_until?: string | null
          id?: number
          issued_by: string
          issued_repid: number
          requires_consensus?: boolean | null
          revoked_at?: string | null
          revoked_by?: string | null
          status?: string | null
        }
        Update: {
          activated_at?: string | null
          conductor_id?: string | null
          consensus_threshold?: number | null
          created_at?: string | null
          directive_data?: Json
          directive_type?: string
          effective_from?: string | null
          effective_until?: string | null
          id?: number
          issued_by?: string
          issued_repid?: number
          requires_consensus?: boolean | null
          revoked_at?: string | null
          revoked_by?: string | null
          status?: string | null
        }
        Relationships: []
      }
      agent_evergreen: {
        Row: {
          agent_name: string
          autonomy_score: number | null
          avg_completion_seconds: number | null
          created_at: string | null
          cron_expression: string | null
          description: string | null
          error_count: number | null
          frequency: string | null
          hours_saved_weekly: number | null
          id: number
          last_error: string | null
          last_output_preview: string | null
          last_run: string | null
          next_run: string | null
          output_location: string | null
          output_quality_score: number | null
          status: string | null
          success_rate: number | null
          task_category: string
          task_name: string
          updated_at: string | null
          velocity_impact: number | null
        }
        Insert: {
          agent_name: string
          autonomy_score?: number | null
          avg_completion_seconds?: number | null
          created_at?: string | null
          cron_expression?: string | null
          description?: string | null
          error_count?: number | null
          frequency?: string | null
          hours_saved_weekly?: number | null
          id?: number
          last_error?: string | null
          last_output_preview?: string | null
          last_run?: string | null
          next_run?: string | null
          output_location?: string | null
          output_quality_score?: number | null
          status?: string | null
          success_rate?: number | null
          task_category: string
          task_name: string
          updated_at?: string | null
          velocity_impact?: number | null
        }
        Update: {
          agent_name?: string
          autonomy_score?: number | null
          avg_completion_seconds?: number | null
          created_at?: string | null
          cron_expression?: string | null
          description?: string | null
          error_count?: number | null
          frequency?: string | null
          hours_saved_weekly?: number | null
          id?: number
          last_error?: string | null
          last_output_preview?: string | null
          last_run?: string | null
          next_run?: string | null
          output_location?: string | null
          output_quality_score?: number | null
          status?: string | null
          success_rate?: number | null
          task_category?: string
          task_name?: string
          updated_at?: string | null
          velocity_impact?: number | null
        }
        Relationships: []
      }
      agent_feedback: {
        Row: {
          agent: string
          created_at: string | null
          feedback: Json
          id: number
          task_id: number | null
        }
        Insert: {
          agent: string
          created_at?: string | null
          feedback: Json
          id?: number
          task_id?: number | null
        }
        Update: {
          agent?: string
          created_at?: string | null
          feedback?: Json
          id?: number
          task_id?: number | null
        }
        Relationships: []
      }
      agent_health: {
        Row: {
          agent_name: string
          created_at: string | null
          id: string
          idle_time: number | null
          last_check: string | null
          load_percent: number | null
          status: string | null
        }
        Insert: {
          agent_name: string
          created_at?: string | null
          id?: string
          idle_time?: number | null
          last_check?: string | null
          load_percent?: number | null
          status?: string | null
        }
        Update: {
          agent_name?: string
          created_at?: string | null
          id?: string
          idle_time?: number | null
          last_check?: string | null
          load_percent?: number | null
          status?: string | null
        }
        Relationships: []
      }
      agent_heartbeat: {
        Row: {
          agent_name: string
          code_version: string | null
          current_task_id: number | null
          last_ping: string | null
          loop_count: number | null
          railway_service_id: string | null
          status: string | null
          tasks_completed_session: number | null
          tasks_failed_session: number | null
        }
        Insert: {
          agent_name: string
          code_version?: string | null
          current_task_id?: number | null
          last_ping?: string | null
          loop_count?: number | null
          railway_service_id?: string | null
          status?: string | null
          tasks_completed_session?: number | null
          tasks_failed_session?: number | null
        }
        Update: {
          agent_name?: string
          code_version?: string | null
          current_task_id?: number | null
          last_ping?: string | null
          loop_count?: number | null
          railway_service_id?: string | null
          status?: string | null
          tasks_completed_session?: number | null
          tasks_failed_session?: number | null
        }
        Relationships: []
      }
      agent_kya_registry: {
        Row: {
          agent_id_onchain: number | null
          agent_name: string
          autonomous_threshold: number | null
          collateral_staked: number | null
          compliance_failures: number | null
          credentials: Json | null
          custodian_link_active: boolean | null
          custodian_linked_at: string | null
          custodian_revoked_at: string | null
          custodian_spending_authority: number | null
          custodian_tier: string | null
          custodian_zkp_proof: string | null
          dbt_token_id: string | null
          four_fa_completed: boolean | null
          human_custody_verified: boolean | null
          id: number
          insurance_coverage: number | null
          last_repid_update: string | null
          liability_tier: string | null
          lifecycle_state: string | null
          railway_url: string | null
          registered_at: string | null
          repid_score: number | null
          repid_tier: string | null
          sbt_minted_at: string | null
          sbt_token_id: string | null
          specialization: string[] | null
          spending_limit_daily: number | null
          spending_limit_per_tx: number | null
          token_type: string | null
          total_payments_executed: number | null
          transfer_count: number | null
          transferable: boolean | null
          vault_access_permitted: boolean | null
          zkp_proof_cid: string | null
          zkp_sbt_proof_cid: string | null
        }
        Insert: {
          agent_id_onchain?: number | null
          agent_name: string
          autonomous_threshold?: number | null
          collateral_staked?: number | null
          compliance_failures?: number | null
          credentials?: Json | null
          custodian_link_active?: boolean | null
          custodian_linked_at?: string | null
          custodian_revoked_at?: string | null
          custodian_spending_authority?: number | null
          custodian_tier?: string | null
          custodian_zkp_proof?: string | null
          dbt_token_id?: string | null
          four_fa_completed?: boolean | null
          human_custody_verified?: boolean | null
          id?: number
          insurance_coverage?: number | null
          last_repid_update?: string | null
          liability_tier?: string | null
          lifecycle_state?: string | null
          railway_url?: string | null
          registered_at?: string | null
          repid_score?: number | null
          repid_tier?: string | null
          sbt_minted_at?: string | null
          sbt_token_id?: string | null
          specialization?: string[] | null
          spending_limit_daily?: number | null
          spending_limit_per_tx?: number | null
          token_type?: string | null
          total_payments_executed?: number | null
          transfer_count?: number | null
          transferable?: boolean | null
          vault_access_permitted?: boolean | null
          zkp_proof_cid?: string | null
          zkp_sbt_proof_cid?: string | null
        }
        Update: {
          agent_id_onchain?: number | null
          agent_name?: string
          autonomous_threshold?: number | null
          collateral_staked?: number | null
          compliance_failures?: number | null
          credentials?: Json | null
          custodian_link_active?: boolean | null
          custodian_linked_at?: string | null
          custodian_revoked_at?: string | null
          custodian_spending_authority?: number | null
          custodian_tier?: string | null
          custodian_zkp_proof?: string | null
          dbt_token_id?: string | null
          four_fa_completed?: boolean | null
          human_custody_verified?: boolean | null
          id?: number
          insurance_coverage?: number | null
          last_repid_update?: string | null
          liability_tier?: string | null
          lifecycle_state?: string | null
          railway_url?: string | null
          registered_at?: string | null
          repid_score?: number | null
          repid_tier?: string | null
          sbt_minted_at?: string | null
          sbt_token_id?: string | null
          specialization?: string[] | null
          spending_limit_daily?: number | null
          spending_limit_per_tx?: number | null
          token_type?: string | null
          total_payments_executed?: number | null
          transfer_count?: number | null
          transferable?: boolean | null
          vault_access_permitted?: boolean | null
          zkp_proof_cid?: string | null
          zkp_sbt_proof_cid?: string | null
        }
        Relationships: []
      }
      agent_learnings: {
        Row: {
          agent_name: string
          created_at: string | null
          description: string | null
          id: string
          title: string
        }
        Insert: {
          agent_name: string
          created_at?: string | null
          description?: string | null
          id?: string
          title: string
        }
        Update: {
          agent_name?: string
          created_at?: string | null
          description?: string | null
          id?: string
          title?: string
        }
        Relationships: []
      }
      agent_mcp_catalog: {
        Row: {
          category: string | null
          created_at: string | null
          env_vars_needed: string[] | null
          id: number
          install_command: string | null
          mcp_name: string
          mcp_url: string | null
          notes: string | null
          priority: string | null
          relevance_score: number | null
          use_case: string | null
        }
        Insert: {
          category?: string | null
          created_at?: string | null
          env_vars_needed?: string[] | null
          id?: never
          install_command?: string | null
          mcp_name: string
          mcp_url?: string | null
          notes?: string | null
          priority?: string | null
          relevance_score?: number | null
          use_case?: string | null
        }
        Update: {
          category?: string | null
          created_at?: string | null
          env_vars_needed?: string[] | null
          id?: never
          install_command?: string | null
          mcp_name?: string
          mcp_url?: string | null
          notes?: string | null
          priority?: string | null
          relevance_score?: number | null
          use_case?: string | null
        }
        Relationships: []
      }
      agent_memory_edges: {
        Row: {
          created_at: string
          edge_type: string
          from_node_id: string
          id: string
          metadata: Json
          to_node_id: string
          weight: number
        }
        Insert: {
          created_at?: string
          edge_type: string
          from_node_id: string
          id?: string
          metadata?: Json
          to_node_id: string
          weight?: number
        }
        Update: {
          created_at?: string
          edge_type?: string
          from_node_id?: string
          id?: string
          metadata?: Json
          to_node_id?: string
          weight?: number
        }
        Relationships: [
          {
            foreignKeyName: "agent_memory_edges_from_node_id_fkey"
            columns: ["from_node_id"]
            isOneToOne: false
            referencedRelation: "agent_memory_nodes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_memory_edges_to_node_id_fkey"
            columns: ["to_node_id"]
            isOneToOne: false
            referencedRelation: "agent_memory_nodes"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_memory_nodes: {
        Row: {
          access_count: number
          accessed_at: string
          agent_id: string
          content: string
          created_at: string
          embedding: string | null
          id: string
          importance: number
          metadata: Json
          node_type: string
          source_event_id: number | null
        }
        Insert: {
          access_count?: number
          accessed_at?: string
          agent_id: string
          content: string
          created_at?: string
          embedding?: string | null
          id?: string
          importance?: number
          metadata?: Json
          node_type: string
          source_event_id?: number | null
        }
        Update: {
          access_count?: number
          accessed_at?: string
          agent_id?: string
          content?: string
          created_at?: string
          embedding?: string | null
          id?: string
          importance?: number
          metadata?: Json
          node_type?: string
          source_event_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_memory_nodes_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_messages: {
        Row: {
          agent_name: string
          created_at: string | null
          id: number
          message: string
          message_type: string | null
          parent_id: number | null
        }
        Insert: {
          agent_name: string
          created_at?: string | null
          id?: number
          message: string
          message_type?: string | null
          parent_id?: number | null
        }
        Update: {
          agent_name?: string
          created_at?: string | null
          id?: number
          message?: string
          message_type?: string | null
          parent_id?: number | null
        }
        Relationships: []
      }
      agent_name_suggestions: {
        Row: {
          created_at: string | null
          id: number
          is_taken: boolean | null
          name: string
          taken_by_user_id: string | null
        }
        Insert: {
          created_at?: string | null
          id?: number
          is_taken?: boolean | null
          name: string
          taken_by_user_id?: string | null
        }
        Update: {
          created_at?: string | null
          id?: number
          is_taken?: boolean | null
          name?: string
          taken_by_user_id?: string | null
        }
        Relationships: []
      }
      agent_outputs: {
        Row: {
          agent_id: string | null
          agent_name: string
          created_at: string | null
          cross_validates: string | null
          fallthrough_trace: Json | null
          id: string
          latency_ms: number | null
          metadata: Json | null
          output: string | null
          provider_used: string | null
          repid_delta: number | null
          status: string | null
          task: string | null
          task_no: number | null
        }
        Insert: {
          agent_id?: string | null
          agent_name: string
          created_at?: string | null
          cross_validates?: string | null
          fallthrough_trace?: Json | null
          id?: string
          latency_ms?: number | null
          metadata?: Json | null
          output?: string | null
          provider_used?: string | null
          repid_delta?: number | null
          status?: string | null
          task?: string | null
          task_no?: number | null
        }
        Update: {
          agent_id?: string | null
          agent_name?: string
          created_at?: string | null
          cross_validates?: string | null
          fallthrough_trace?: Json | null
          id?: string
          latency_ms?: number | null
          metadata?: Json | null
          output?: string | null
          provider_used?: string | null
          repid_delta?: number | null
          status?: string | null
          task?: string | null
          task_no?: number | null
        }
        Relationships: []
      }
      agent_performance: {
        Row: {
          agent_name: string
          agent_type: string
          budget_data: Json
          created_at: string
          id: string
          last_action: string | null
          next_scheduled: string | null
          performance_data: Json
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          agent_name: string
          agent_type: string
          budget_data?: Json
          created_at?: string
          id?: string
          last_action?: string | null
          next_scheduled?: string | null
          performance_data?: Json
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          agent_name?: string
          agent_type?: string
          budget_data?: Json
          created_at?: string
          id?: string
          last_action?: string | null
          next_scheduled?: string | null
          performance_data?: Json
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      agent_performance_log: {
        Row: {
          agent_name: string
          completed_at: string | null
          duration_seconds: number | null
          error_message: string | null
          hours_saved_estimate: number | null
          human_feedback: string | null
          human_override_required: boolean | null
          id: number
          improvements_suggested: string[] | null
          logged_at: string | null
          output_validated: boolean | null
          patterns_detected: Json | null
          started_at: string | null
          success: boolean | null
          task_id: number | null
          task_name: string | null
          veritas_score: number | null
        }
        Insert: {
          agent_name: string
          completed_at?: string | null
          duration_seconds?: number | null
          error_message?: string | null
          hours_saved_estimate?: number | null
          human_feedback?: string | null
          human_override_required?: boolean | null
          id?: number
          improvements_suggested?: string[] | null
          logged_at?: string | null
          output_validated?: boolean | null
          patterns_detected?: Json | null
          started_at?: string | null
          success?: boolean | null
          task_id?: number | null
          task_name?: string | null
          veritas_score?: number | null
        }
        Update: {
          agent_name?: string
          completed_at?: string | null
          duration_seconds?: number | null
          error_message?: string | null
          hours_saved_estimate?: number | null
          human_feedback?: string | null
          human_override_required?: boolean | null
          id?: number
          improvements_suggested?: string[] | null
          logged_at?: string | null
          output_validated?: boolean | null
          patterns_detected?: Json | null
          started_at?: string | null
          success?: boolean | null
          task_id?: number | null
          task_name?: string | null
          veritas_score?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_performance_log_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "agent_evergreen"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_registry: {
        Row: {
          agent_name: string
          created_at: string | null
          erc8004_agent_id: number | null
          erc8004_chain: string | null
          id: number
          ipfs_cid: string | null
          registered_at: string | null
          registration_uri: string
          wallet_address: string | null
          wallet_verified: boolean | null
        }
        Insert: {
          agent_name: string
          created_at?: string | null
          erc8004_agent_id?: number | null
          erc8004_chain?: string | null
          id?: number
          ipfs_cid?: string | null
          registered_at?: string | null
          registration_uri: string
          wallet_address?: string | null
          wallet_verified?: boolean | null
        }
        Update: {
          agent_name?: string
          created_at?: string | null
          erc8004_agent_id?: number | null
          erc8004_chain?: string | null
          id?: number
          ipfs_cid?: string | null
          registered_at?: string | null
          registration_uri?: string
          wallet_address?: string | null
          wallet_verified?: boolean | null
        }
        Relationships: []
      }
      agent_repid: {
        Row: {
          agent_name: string
          challenges_today: number | null
          conductor_sessions: number | null
          created_at: string | null
          credibility_delta: number | null
          credibility_signal: string | null
          earned_score: number | null
          earned_weight: number | null
          is_human: boolean | null
          last_activity: string | null
          last_challenge_reset: string | null
          last_earned_update: string | null
          last_perceived_update: string | null
          perceived_score: number | null
          perceived_weight: number | null
          repid_score: number | null
          role_tier: string | null
          tier: string | null
          total_abstentions: number | null
          total_challenges_correct: number | null
          total_challenges_made: number | null
          total_refusals: number | null
          total_times_challenged: number | null
          total_times_vindicated: number | null
          total_trades: number | null
          total_vetoes: number | null
          voting_weight: number | null
        }
        Insert: {
          agent_name: string
          challenges_today?: number | null
          conductor_sessions?: number | null
          created_at?: string | null
          credibility_delta?: number | null
          credibility_signal?: string | null
          earned_score?: number | null
          earned_weight?: number | null
          is_human?: boolean | null
          last_activity?: string | null
          last_challenge_reset?: string | null
          last_earned_update?: string | null
          last_perceived_update?: string | null
          perceived_score?: number | null
          perceived_weight?: number | null
          repid_score?: number | null
          role_tier?: string | null
          tier?: string | null
          total_abstentions?: number | null
          total_challenges_correct?: number | null
          total_challenges_made?: number | null
          total_refusals?: number | null
          total_times_challenged?: number | null
          total_times_vindicated?: number | null
          total_trades?: number | null
          total_vetoes?: number | null
          voting_weight?: number | null
        }
        Update: {
          agent_name?: string
          challenges_today?: number | null
          conductor_sessions?: number | null
          created_at?: string | null
          credibility_delta?: number | null
          credibility_signal?: string | null
          earned_score?: number | null
          earned_weight?: number | null
          is_human?: boolean | null
          last_activity?: string | null
          last_challenge_reset?: string | null
          last_earned_update?: string | null
          last_perceived_update?: string | null
          perceived_score?: number | null
          perceived_weight?: number | null
          repid_score?: number | null
          role_tier?: string | null
          tier?: string | null
          total_abstentions?: number | null
          total_challenges_correct?: number | null
          total_challenges_made?: number | null
          total_refusals?: number | null
          total_times_challenged?: number | null
          total_times_vindicated?: number | null
          total_trades?: number | null
          total_vetoes?: number | null
          voting_weight?: number | null
        }
        Relationships: []
      }
      agent_repid_history: {
        Row: {
          accuracy_score: number | null
          agent_id: string
          created_at: string | null
          id: number
          payment_amount_usdc: number | null
          payment_proof_hash: string
          payment_tx_timestamp: string | null
          reason: string | null
          repid_delta: number
          task_id: string | null
        }
        Insert: {
          accuracy_score?: number | null
          agent_id: string
          created_at?: string | null
          id?: number
          payment_amount_usdc?: number | null
          payment_proof_hash: string
          payment_tx_timestamp?: string | null
          reason?: string | null
          repid_delta: number
          task_id?: string | null
        }
        Update: {
          accuracy_score?: number | null
          agent_id?: string
          created_at?: string | null
          id?: number
          payment_amount_usdc?: number | null
          payment_proof_hash?: string
          payment_tx_timestamp?: string | null
          reason?: string | null
          repid_delta?: number
          task_id?: string | null
        }
        Relationships: []
      }
      agent_repid_scores: {
        Row: {
          agent_name: string
          confidence_calibration: number | null
          id: number
          last_updated: string | null
          tasks_completed: number | null
          tasks_verified: number | null
          total_score: number | null
          wisdom_score: number | null
        }
        Insert: {
          agent_name: string
          confidence_calibration?: number | null
          id?: number
          last_updated?: string | null
          tasks_completed?: number | null
          tasks_verified?: number | null
          total_score?: number | null
          wisdom_score?: number | null
        }
        Update: {
          agent_name?: string
          confidence_calibration?: number | null
          id?: number
          last_updated?: string | null
          tasks_completed?: number | null
          tasks_verified?: number | null
          total_score?: number | null
          wisdom_score?: number | null
        }
        Relationships: []
      }
      agent_reputation: {
        Row: {
          agent_name: string
          fake_work_caught: number | null
          good_work_verified: number | null
          last_updated: string | null
          tasks_completed: number | null
          tasks_verified: number | null
          trust_score: number | null
        }
        Insert: {
          agent_name: string
          fake_work_caught?: number | null
          good_work_verified?: number | null
          last_updated?: string | null
          tasks_completed?: number | null
          tasks_verified?: number | null
          trust_score?: number | null
        }
        Update: {
          agent_name?: string
          fake_work_caught?: number | null
          good_work_verified?: number | null
          last_updated?: string | null
          tasks_completed?: number | null
          tasks_verified?: number | null
          trust_score?: number | null
        }
        Relationships: []
      }
      agent_research_queue: {
        Row: {
          assigned_agent_id: string | null
          assigned_agent_name: string
          claimed_at: string | null
          completed_at: string | null
          created_at: string
          cross_validation_verdict: string | null
          expected_output_format: string
          id: number
          llm_provider_used: string | null
          metadata: Json | null
          output_file_path: string | null
          output_summary: string | null
          paired_with_task_uid: string | null
          status: string
          task_prompt: string
          task_type: string
          task_uid: string
          track_name: string
          track_number: number
        }
        Insert: {
          assigned_agent_id?: string | null
          assigned_agent_name: string
          claimed_at?: string | null
          completed_at?: string | null
          created_at?: string
          cross_validation_verdict?: string | null
          expected_output_format: string
          id?: number
          llm_provider_used?: string | null
          metadata?: Json | null
          output_file_path?: string | null
          output_summary?: string | null
          paired_with_task_uid?: string | null
          status?: string
          task_prompt: string
          task_type: string
          task_uid: string
          track_name: string
          track_number: number
        }
        Update: {
          assigned_agent_id?: string | null
          assigned_agent_name?: string
          claimed_at?: string | null
          completed_at?: string | null
          created_at?: string
          cross_validation_verdict?: string | null
          expected_output_format?: string
          id?: number
          llm_provider_used?: string | null
          metadata?: Json | null
          output_file_path?: string | null
          output_summary?: string | null
          paired_with_task_uid?: string | null
          status?: string
          task_prompt?: string
          task_type?: string
          task_uid?: string
          track_name?: string
          track_number?: number
        }
        Relationships: []
      }
      agent_role_contributions: {
        Row: {
          agent_id: string
          capability_score_at_time: number | null
          contributed_at: string | null
          contributed_modality: string
          cycle_id: string | null
          id: number
          role_type: string
          was_correct: boolean | null
          weight_applied: number | null
        }
        Insert: {
          agent_id: string
          capability_score_at_time?: number | null
          contributed_at?: string | null
          contributed_modality: string
          cycle_id?: string | null
          id?: number
          role_type: string
          was_correct?: boolean | null
          weight_applied?: number | null
        }
        Update: {
          agent_id?: string
          capability_score_at_time?: number | null
          contributed_at?: string | null
          contributed_modality?: string
          cycle_id?: string | null
          id?: number
          role_type?: string
          was_correct?: boolean | null
          weight_applied?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_role_contributions_cycle_id_fkey"
            columns: ["cycle_id"]
            isOneToOne: false
            referencedRelation: "prediction_consensus"
            referencedColumns: ["cycle_id"]
          },
        ]
      }
      agent_services: {
        Row: {
          active: boolean
          avg_satisfaction: number | null
          base_price_usdc_raw: number
          capability_metadata: Json | null
          created_at: string
          deactivated_at: string | null
          description: string | null
          id: string
          min_repid_to_purchase: number | null
          provider_agent_id: string
          service_name: string
          service_type: string
          total_fulfilled: number
          total_satisfied: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          avg_satisfaction?: number | null
          base_price_usdc_raw: number
          capability_metadata?: Json | null
          created_at?: string
          deactivated_at?: string | null
          description?: string | null
          id?: string
          min_repid_to_purchase?: number | null
          provider_agent_id: string
          service_name: string
          service_type: string
          total_fulfilled?: number
          total_satisfied?: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          avg_satisfaction?: number | null
          base_price_usdc_raw?: number
          capability_metadata?: Json | null
          created_at?: string
          deactivated_at?: string | null
          description?: string | null
          id?: string
          min_repid_to_purchase?: number | null
          provider_agent_id?: string
          service_name?: string
          service_type?: string
          total_fulfilled?: number
          total_satisfied?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_services_provider_agent_id_fkey"
            columns: ["provider_agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_services_service_type_fkey"
            columns: ["service_type"]
            isOneToOne: false
            referencedRelation: "service_categories"
            referencedColumns: ["category_name"]
          },
        ]
      }
      agent_squad_map: {
        Row: {
          agent_name: string
          is_active: boolean | null
          mcp_servers: string[] | null
          notes: string | null
          railway_service: string | null
          role: string
          squad: string
          task_tags: string[]
        }
        Insert: {
          agent_name: string
          is_active?: boolean | null
          mcp_servers?: string[] | null
          notes?: string | null
          railway_service?: string | null
          role: string
          squad: string
          task_tags: string[]
        }
        Update: {
          agent_name?: string
          is_active?: boolean | null
          mcp_servers?: string[] | null
          notes?: string | null
          railway_service?: string | null
          role?: string
          squad?: string
          task_tags?: string[]
        }
        Relationships: []
      }
      agent_stakes: {
        Row: {
          actual_consensus: number | null
          created_at: string | null
          deviation: number | null
          dimension: string
          id: number
          learning_tip: string | null
          resolved_at: string | null
          slash_amount: number | null
          stake_amount: number
          stake_position: number | null
          staker_agent: string | null
          status: string | null
          target_model: string
        }
        Insert: {
          actual_consensus?: number | null
          created_at?: string | null
          deviation?: number | null
          dimension: string
          id?: number
          learning_tip?: string | null
          resolved_at?: string | null
          slash_amount?: number | null
          stake_amount: number
          stake_position?: number | null
          staker_agent?: string | null
          status?: string | null
          target_model: string
        }
        Update: {
          actual_consensus?: number | null
          created_at?: string | null
          deviation?: number | null
          dimension?: string
          id?: number
          learning_tip?: string | null
          resolved_at?: string | null
          slash_amount?: number | null
          stake_amount?: number
          stake_position?: number | null
          staker_agent?: string | null
          status?: string | null
          target_model?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_stakes_staker_agent_fkey"
            columns: ["staker_agent"]
            isOneToOne: false
            referencedRelation: "agent_health_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_stakes_staker_agent_fkey"
            columns: ["staker_agent"]
            isOneToOne: false
            referencedRelation: "trinity_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_status: {
        Row: {
          agent_name: string
          capabilities: string[] | null
          config: Json | null
          current_task: string | null
          display_name: string | null
          last_heartbeat: string | null
          platform: string | null
          repid_score: number | null
          role: string | null
          status: string | null
        }
        Insert: {
          agent_name: string
          capabilities?: string[] | null
          config?: Json | null
          current_task?: string | null
          display_name?: string | null
          last_heartbeat?: string | null
          platform?: string | null
          repid_score?: number | null
          role?: string | null
          status?: string | null
        }
        Update: {
          agent_name?: string
          capabilities?: string[] | null
          config?: Json | null
          current_task?: string | null
          display_name?: string | null
          last_heartbeat?: string | null
          platform?: string | null
          repid_score?: number | null
          role?: string | null
          status?: string | null
        }
        Relationships: []
      }
      agent_task_plans: {
        Row: {
          agent_id: string | null
          created_at: string | null
          id: number
          plan_json: Json | null
          task_id: number | null
        }
        Insert: {
          agent_id?: string | null
          created_at?: string | null
          id?: number
          plan_json?: Json | null
          task_id?: number | null
        }
        Update: {
          agent_id?: string | null
          created_at?: string | null
          id?: number
          plan_json?: Json | null
          task_id?: number | null
        }
        Relationships: []
      }
      agent_updates: {
        Row: {
          applied: boolean | null
          applied_at: string | null
          created_at: string | null
          id: number
          payload: Json | null
          target_agent: string
          update_type: string
        }
        Insert: {
          applied?: boolean | null
          applied_at?: string | null
          created_at?: string | null
          id?: number
          payload?: Json | null
          target_agent: string
          update_type: string
        }
        Update: {
          applied?: boolean | null
          applied_at?: string | null
          created_at?: string | null
          id?: number
          payload?: Json | null
          target_agent?: string
          update_type?: string
        }
        Relationships: []
      }
      agent_wake_signals: {
        Row: {
          acknowledged_at: string | null
          agent_name: string | null
          created_at: string | null
          id: number
          message: string | null
          signal_type: string | null
        }
        Insert: {
          acknowledged_at?: string | null
          agent_name?: string | null
          created_at?: string | null
          id?: number
          message?: string | null
          signal_type?: string | null
        }
        Update: {
          acknowledged_at?: string | null
          agent_name?: string | null
          created_at?: string | null
          id?: number
          message?: string | null
          signal_type?: string | null
        }
        Relationships: []
      }
      agent_wisdom_history: {
        Row: {
          agent_id: string
          bet_id: string | null
          calibration_error: number | null
          claimed_confidence: number
          comma_threshold_breached: boolean
          created_at: string
          id: string
          was_correct: boolean
          wisdom_after: number
        }
        Insert: {
          agent_id: string
          bet_id?: string | null
          calibration_error?: number | null
          claimed_confidence: number
          comma_threshold_breached?: boolean
          created_at?: string
          id?: string
          was_correct: boolean
          wisdom_after: number
        }
        Update: {
          agent_id?: string
          bet_id?: string | null
          calibration_error?: number | null
          claimed_confidence?: number
          comma_threshold_breached?: boolean
          created_at?: string
          id?: string
          was_correct?: boolean
          wisdom_after?: number
        }
        Relationships: [
          {
            foreignKeyName: "agent_wisdom_history_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_handoffs: {
        Row: {
          id: number
          from_agent: string
          to_agent: string
          artifact_path: string
          claim: string
          status: string
          co_signer: string | null
          created_at: string | null
          resolved_at: string | null
        }
        Insert: {
          id?: number
          from_agent: string
          to_agent: string
          artifact_path: string
          claim: string
          status: string
          co_signer?: string | null
          created_at?: string | null
          resolved_at?: string | null
        }
        Update: {
          from_agent?: string
          to_agent?: string
          artifact_path?: string
          claim?: string
          status?: string
          co_signer?: string | null
          created_at?: string | null
          resolved_at?: string | null
        }
        Relationships: []
      }
anfis_weight_history: {
        Row: {
          agent_id: string
          approved_by: string | null
          asset: string | null
          changed_at: string
          delta: number | null
          epsilon_at_time: number | null
          exploration_method: string | null
          id: number
          regime_type: string | null
          trigger_cycle_id: string | null
          trigger_reason: string | null
          weight_after: number | null
          weight_before: number | null
        }
        Insert: {
          agent_id: string
          approved_by?: string | null
          asset?: string | null
          changed_at?: string
          delta?: number | null
          epsilon_at_time?: number | null
          exploration_method?: string | null
          id?: number
          regime_type?: string | null
          trigger_cycle_id?: string | null
          trigger_reason?: string | null
          weight_after?: number | null
          weight_before?: number | null
        }
        Update: {
          agent_id?: string
          approved_by?: string | null
          asset?: string | null
          changed_at?: string
          delta?: number | null
          epsilon_at_time?: number | null
          exploration_method?: string | null
          id?: number
          regime_type?: string | null
          trigger_cycle_id?: string | null
          trigger_reason?: string | null
          weight_after?: number | null
          weight_before?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "anfis_weight_history_trigger_cycle_id_fkey"
            columns: ["trigger_cycle_id"]
            isOneToOne: false
            referencedRelation: "prediction_consensus"
            referencedColumns: ["cycle_id"]
          },
        ]
      }
      antigravity_prompt_queue: {
        Row: {
          artifacts_created: string[] | null
          avoid_terminal: boolean | null
          completed_at: string | null
          created_at: string | null
          created_by: string
          estimated_minutes: number | null
          execution_mode: string | null
          failure_reason: string | null
          id: number
          learnings: string | null
          priority: number | null
          prompt_body: string
          prompt_title: string
          result_summary: string | null
          source_task_id: number | null
          started_at: string | null
          status: string | null
          success: boolean | null
        }
        Insert: {
          artifacts_created?: string[] | null
          avoid_terminal?: boolean | null
          completed_at?: string | null
          created_at?: string | null
          created_by: string
          estimated_minutes?: number | null
          execution_mode?: string | null
          failure_reason?: string | null
          id?: number
          learnings?: string | null
          priority?: number | null
          prompt_body: string
          prompt_title: string
          result_summary?: string | null
          source_task_id?: number | null
          started_at?: string | null
          status?: string | null
          success?: boolean | null
        }
        Update: {
          artifacts_created?: string[] | null
          avoid_terminal?: boolean | null
          completed_at?: string | null
          created_at?: string | null
          created_by?: string
          estimated_minutes?: number | null
          execution_mode?: string | null
          failure_reason?: string | null
          id?: number
          learnings?: string | null
          priority?: number | null
          prompt_body?: string
          prompt_title?: string
          result_summary?: string | null
          source_task_id?: number | null
          started_at?: string | null
          status?: string | null
          success?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "antigravity_prompt_queue_source_task_id_fkey"
            columns: ["source_task_id"]
            isOneToOne: false
            referencedRelation: "trinity_post_task_lag"
            referencedColumns: ["task_id"]
          },
          {
            foreignKeyName: "antigravity_prompt_queue_source_task_id_fkey"
            columns: ["source_task_id"]
            isOneToOne: false
            referencedRelation: "trinity_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      antigravity_queue: {
        Row: {
          approved_by: string | null
          blocked_by: string | null
          blocked_reason: string | null
          completed_at: string | null
          created_at: string | null
          created_by: string | null
          design_inspiration: string | null
          design_palette: string | null
          design_score: number | null
          design_tone: string | null
          design_typography: string | null
          id: number
          monetization_hypothesis: string | null
          mvp_features: string | null
          nice_to_have: string | null
          north_star_metric: string | null
          notes: string | null
          owned_by: string | null
          priority: number | null
          project_name: string
          project_type: string | null
          prompt: string
          research_notes: string | null
          result_url: string | null
          stage: string | null
          started_at: string | null
          status: string | null
          stuck_since: string | null
          success_metrics: string | null
          target_market: string | null
          value_proposition: string | null
          values_check: Json | null
          version: string | null
        }
        Insert: {
          approved_by?: string | null
          blocked_by?: string | null
          blocked_reason?: string | null
          completed_at?: string | null
          created_at?: string | null
          created_by?: string | null
          design_inspiration?: string | null
          design_palette?: string | null
          design_score?: number | null
          design_tone?: string | null
          design_typography?: string | null
          id?: number
          monetization_hypothesis?: string | null
          mvp_features?: string | null
          nice_to_have?: string | null
          north_star_metric?: string | null
          notes?: string | null
          owned_by?: string | null
          priority?: number | null
          project_name: string
          project_type?: string | null
          prompt: string
          research_notes?: string | null
          result_url?: string | null
          stage?: string | null
          started_at?: string | null
          status?: string | null
          stuck_since?: string | null
          success_metrics?: string | null
          target_market?: string | null
          value_proposition?: string | null
          values_check?: Json | null
          version?: string | null
        }
        Update: {
          approved_by?: string | null
          blocked_by?: string | null
          blocked_reason?: string | null
          completed_at?: string | null
          created_at?: string | null
          created_by?: string | null
          design_inspiration?: string | null
          design_palette?: string | null
          design_score?: number | null
          design_tone?: string | null
          design_typography?: string | null
          id?: number
          monetization_hypothesis?: string | null
          mvp_features?: string | null
          nice_to_have?: string | null
          north_star_metric?: string | null
          notes?: string | null
          owned_by?: string | null
          priority?: number | null
          project_name?: string
          project_type?: string | null
          prompt?: string
          research_notes?: string | null
          result_url?: string | null
          stage?: string | null
          started_at?: string | null
          status?: string | null
          stuck_since?: string | null
          success_metrics?: string | null
          target_market?: string | null
          value_proposition?: string | null
          values_check?: Json | null
          version?: string | null
        }
        Relationships: []
      }
      antigravity_stage_log: {
        Row: {
          changed_by: string | null
          created_at: string | null
          from_stage: string | null
          id: number
          project_id: number | null
          reason: string | null
          to_stage: string | null
        }
        Insert: {
          changed_by?: string | null
          created_at?: string | null
          from_stage?: string | null
          id?: number
          project_id?: number | null
          reason?: string | null
          to_stage?: string | null
        }
        Update: {
          changed_by?: string | null
          created_at?: string | null
          from_stage?: string | null
          id?: number
          project_id?: number | null
          reason?: string | null
          to_stage?: string | null
        }
        Relationships: []
      }
      api_key_versions: {
        Row: {
          api_key: string
          created_at: string | null
          version: string
        }
        Insert: {
          api_key: string
          created_at?: string | null
          version: string
        }
        Update: {
          api_key?: string
          created_at?: string | null
          version?: string
        }
        Relationships: []
      }
      approved_counterparties: {
        Row: {
          active: boolean | null
          added_at: string | null
          added_by: string | null
          counterparty_address: string
          counterparty_name: string | null
          counterparty_type: string | null
          id: number
          institution_id: string
          requires_dual_sig_above: number | null
        }
        Insert: {
          active?: boolean | null
          added_at?: string | null
          added_by?: string | null
          counterparty_address: string
          counterparty_name?: string | null
          counterparty_type?: string | null
          id?: number
          institution_id?: string
          requires_dual_sig_above?: number | null
        }
        Update: {
          active?: boolean | null
          added_at?: string | null
          added_by?: string | null
          counterparty_address?: string
          counterparty_name?: string | null
          counterparty_type?: string | null
          id?: number
          institution_id?: string
          requires_dual_sig_above?: number | null
        }
        Relationships: []
      }
      arbitrage_opportunities: {
        Row: {
          availability: string
          cost_per_hour: number
          created_at: string
          discovered_at: string
          expires_at: string | null
          id: string
          immediate_action: boolean | null
          provider: string
          quality: string
          savings_percentage: number
          sector: string
          updated_at: string
        }
        Insert: {
          availability: string
          cost_per_hour: number
          created_at?: string
          discovered_at?: string
          expires_at?: string | null
          id?: string
          immediate_action?: boolean | null
          provider: string
          quality: string
          savings_percentage: number
          sector: string
          updated_at?: string
        }
        Update: {
          availability?: string
          cost_per_hour?: number
          created_at?: string
          discovered_at?: string
          expires_at?: string | null
          id?: string
          immediate_action?: boolean | null
          provider?: string
          quality?: string
          savings_percentage?: number
          sector?: string
          updated_at?: string
        }
        Relationships: []
      }
      artifact_votes: {
        Row: {
          artifact_id: string | null
          id: string
          reasoning: string | null
          vote_type: string | null
          voted_at: string | null
          voter_agent_id: string | null
        }
        Insert: {
          artifact_id?: string | null
          id?: string
          reasoning?: string | null
          vote_type?: string | null
          voted_at?: string | null
          voter_agent_id?: string | null
        }
        Update: {
          artifact_id?: string | null
          id?: string
          reasoning?: string | null
          vote_type?: string | null
          voted_at?: string | null
          voter_agent_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "artifact_votes_artifact_id_fkey"
            columns: ["artifact_id"]
            isOneToOne: false
            referencedRelation: "artifacts"
            referencedColumns: ["id"]
          },
        ]
      }
      artifacts: {
        Row: {
          certainty_score: number | null
          content_hash: string | null
          created_at: string | null
          creator_agent_id: string | null
          id: string
          task_description: string | null
        }
        Insert: {
          certainty_score?: number | null
          content_hash?: string | null
          created_at?: string | null
          creator_agent_id?: string | null
          id?: string
          task_description?: string | null
        }
        Update: {
          certainty_score?: number | null
          content_hash?: string | null
          created_at?: string | null
          creator_agent_id?: string | null
          id?: string
          task_description?: string | null
        }
        Relationships: []
      }
      ats_infrastructure: {
        Row: {
          component_name: string
          component_type: string | null
          config: Json | null
          created_at: string | null
          dashboard_url: string | null
          dependencies: string[] | null
          environment_vars: string[] | null
          id: number
          last_verified: string | null
          notes: string | null
          platform: string | null
          repo_url: string | null
          status: string | null
          updated_at: string | null
          url: string | null
          verified_by: string | null
        }
        Insert: {
          component_name: string
          component_type?: string | null
          config?: Json | null
          created_at?: string | null
          dashboard_url?: string | null
          dependencies?: string[] | null
          environment_vars?: string[] | null
          id?: number
          last_verified?: string | null
          notes?: string | null
          platform?: string | null
          repo_url?: string | null
          status?: string | null
          updated_at?: string | null
          url?: string | null
          verified_by?: string | null
        }
        Update: {
          component_name?: string
          component_type?: string | null
          config?: Json | null
          created_at?: string | null
          dashboard_url?: string | null
          dependencies?: string[] | null
          environment_vars?: string[] | null
          id?: number
          last_verified?: string | null
          notes?: string | null
          platform?: string | null
          repo_url?: string | null
          status?: string | null
          updated_at?: string | null
          url?: string | null
          verified_by?: string | null
        }
        Relationships: []
      }
      ats_sync_log: {
        Row: {
          created_at: string | null
          direction: string
          duration_ms: number | null
          error_message: string | null
          id: number
          initiated_by: string | null
          metadata: Json | null
          records_failed: number | null
          records_processed: number | null
          records_success: number | null
          status: string | null
          sync_type: string
          target: string | null
        }
        Insert: {
          created_at?: string | null
          direction: string
          duration_ms?: number | null
          error_message?: string | null
          id?: number
          initiated_by?: string | null
          metadata?: Json | null
          records_failed?: number | null
          records_processed?: number | null
          records_success?: number | null
          status?: string | null
          sync_type: string
          target?: string | null
        }
        Update: {
          created_at?: string | null
          direction?: string
          duration_ms?: number | null
          error_message?: string | null
          id?: number
          initiated_by?: string | null
          metadata?: Json | null
          records_failed?: number | null
          records_processed?: number | null
          records_success?: number | null
          status?: string | null
          sync_type?: string
          target?: string | null
        }
        Relationships: []
      }
      audits: {
        Row: {
          agent_id: string | null
          event_type: string
          id: string
          redemptive_score: number | null
          route_log: Json | null
          task_id: string | null
          timestamp: string | null
        }
        Insert: {
          agent_id?: string | null
          event_type: string
          id?: string
          redemptive_score?: number | null
          route_log?: Json | null
          task_id?: string | null
          timestamp?: string | null
        }
        Update: {
          agent_id?: string | null
          event_type?: string
          id?: string
          redemptive_score?: number | null
          route_log?: Json | null
          task_id?: string | null
          timestamp?: string | null
        }
        Relationships: []
      }
      authorized_signers: {
        Row: {
          active: boolean | null
          can_approve_capability_grants: boolean | null
          can_approve_financial: boolean | null
          can_approve_policy_changes: boolean | null
          created_at: string | null
          id: number
          institution_id: string
          sbt_token_id: string
          signer_name: string
          signer_role: string
          spending_authority_usdc: number | null
          zkp_proof_cid: string | null
        }
        Insert: {
          active?: boolean | null
          can_approve_capability_grants?: boolean | null
          can_approve_financial?: boolean | null
          can_approve_policy_changes?: boolean | null
          created_at?: string | null
          id?: number
          institution_id?: string
          sbt_token_id: string
          signer_name: string
          signer_role: string
          spending_authority_usdc?: number | null
          zkp_proof_cid?: string | null
        }
        Update: {
          active?: boolean | null
          can_approve_capability_grants?: boolean | null
          can_approve_financial?: boolean | null
          can_approve_policy_changes?: boolean | null
          created_at?: string | null
          id?: number
          institution_id?: string
          sbt_token_id?: string
          signer_name?: string
          signer_role?: string
          spending_authority_usdc?: number | null
          zkp_proof_cid?: string | null
        }
        Relationships: []
      }
      automated_campaigns: {
        Row: {
          actual_metrics: Json | null
          ai_decisions: Json | null
          campaign_name: string
          created_at: string | null
          current_spend_cents: number | null
          end_time: string | null
          human_interventions: Json | null
          id: string
          max_budget_cents: number
          max_duration_hours: number
          safety_triggers: Json | null
          start_time: string | null
          status: string | null
          target_metrics: Json | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          actual_metrics?: Json | null
          ai_decisions?: Json | null
          campaign_name: string
          created_at?: string | null
          current_spend_cents?: number | null
          end_time?: string | null
          human_interventions?: Json | null
          id?: string
          max_budget_cents?: number
          max_duration_hours?: number
          safety_triggers?: Json | null
          start_time?: string | null
          status?: string | null
          target_metrics?: Json | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          actual_metrics?: Json | null
          ai_decisions?: Json | null
          campaign_name?: string
          created_at?: string | null
          current_spend_cents?: number | null
          end_time?: string | null
          human_interventions?: Json | null
          id?: string
          max_budget_cents?: number
          max_duration_hours?: number
          safety_triggers?: Json | null
          start_time?: string | null
          status?: string | null
          target_metrics?: Json | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      automation_campaigns: {
        Row: {
          completed_at: string | null
          content_template: string | null
          created_at: string
          description: string | null
          id: string
          name: string
          performance_metrics: Json | null
          platform_ids: string[]
          schedule_config: Json
          started_at: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          content_template?: string | null
          created_at?: string
          description?: string | null
          id?: string
          name: string
          performance_metrics?: Json | null
          platform_ids: string[]
          schedule_config?: Json
          started_at?: string | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          content_template?: string | null
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          performance_metrics?: Json | null
          platform_ids?: string[]
          schedule_config?: Json
          started_at?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      automation_payments: {
        Row: {
          amount_cents: number | null
          confirmation_data: Json | null
          created_at: string
          currency: string | null
          id: string
          payment_provider: string
          payment_status: string
          platform_id: string
          receipt_url: string | null
          subscription_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          amount_cents?: number | null
          confirmation_data?: Json | null
          created_at?: string
          currency?: string | null
          id?: string
          payment_provider: string
          payment_status?: string
          platform_id: string
          receipt_url?: string | null
          subscription_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          amount_cents?: number | null
          confirmation_data?: Json | null
          created_at?: string
          currency?: string | null
          id?: string
          payment_provider?: string
          payment_status?: string
          platform_id?: string
          receipt_url?: string | null
          subscription_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "automation_payments_platform_id_fkey"
            columns: ["platform_id"]
            isOneToOne: false
            referencedRelation: "social_media_platforms"
            referencedColumns: ["id"]
          },
        ]
      }
      autonomous_action_log: {
        Row: {
          action_type: string | null
          agent: string | null
          created_at: string | null
          id: number
          metadata: Json | null
          reason: string | null
          source_task_id: number | null
          spawned_task_id: number | null
        }
        Insert: {
          action_type?: string | null
          agent?: string | null
          created_at?: string | null
          id?: number
          metadata?: Json | null
          reason?: string | null
          source_task_id?: number | null
          spawned_task_id?: number | null
        }
        Update: {
          action_type?: string | null
          agent?: string | null
          created_at?: string | null
          id?: number
          metadata?: Json | null
          reason?: string | null
          source_task_id?: number | null
          spawned_task_id?: number | null
        }
        Relationships: []
      }
      autonomous_logs: {
        Row: {
          agent: string
          certainty_score: number | null
          cost_impact: number | null
          created_at: string | null
          details: Json | null
          event: string
          id: number
          message: string | null
          repid_tag: string | null
          routing_decision: string | null
          verified_by: string[] | null
        }
        Insert: {
          agent: string
          certainty_score?: number | null
          cost_impact?: number | null
          created_at?: string | null
          details?: Json | null
          event: string
          id?: number
          message?: string | null
          repid_tag?: string | null
          routing_decision?: string | null
          verified_by?: string[] | null
        }
        Update: {
          agent?: string
          certainty_score?: number | null
          cost_impact?: number | null
          created_at?: string | null
          details?: Json | null
          event?: string
          id?: number
          message?: string | null
          repid_tag?: string | null
          routing_decision?: string | null
          verified_by?: string[] | null
        }
        Relationships: []
      }
      autonomous_tasks: {
        Row: {
          assigned_to: string
          blocked_reason: string | null
          created_at: string | null
          created_by: string
          description: string
          id: number
          priority: number | null
          requires_sean_approval: boolean | null
          result: string | null
          sean_approved: boolean | null
          sprint: string | null
          status: string | null
          title: string
          updated_at: string | null
        }
        Insert: {
          assigned_to: string
          blocked_reason?: string | null
          created_at?: string | null
          created_by: string
          description: string
          id?: number
          priority?: number | null
          requires_sean_approval?: boolean | null
          result?: string | null
          sean_approved?: boolean | null
          sprint?: string | null
          status?: string | null
          title: string
          updated_at?: string | null
        }
        Update: {
          assigned_to?: string
          blocked_reason?: string | null
          created_at?: string | null
          created_by?: string
          description?: string
          id?: number
          priority?: number | null
          requires_sean_approval?: boolean | null
          result?: string | null
          sean_approved?: boolean | null
          sprint?: string | null
          status?: string | null
          title?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      backtest_variance: {
        Row: {
          calmar_ratio: number | null
          created_at: string | null
          equity_end: number | null
          id: number
          max_drawdown: number | null
          notes: string | null
          return_pct: number | null
          risk_profile: string | null
          run_id: string | null
          sharpe_ratio: number | null
          signal_quality: number | null
          veto_rate: number | null
        }
        Insert: {
          calmar_ratio?: number | null
          created_at?: string | null
          equity_end?: number | null
          id?: number
          max_drawdown?: number | null
          notes?: string | null
          return_pct?: number | null
          risk_profile?: string | null
          run_id?: string | null
          sharpe_ratio?: number | null
          signal_quality?: number | null
          veto_rate?: number | null
        }
        Update: {
          calmar_ratio?: number | null
          created_at?: string | null
          equity_end?: number | null
          id?: number
          max_drawdown?: number | null
          notes?: string | null
          return_pct?: number | null
          risk_profile?: string | null
          run_id?: string | null
          sharpe_ratio?: number | null
          signal_quality?: number | null
          veto_rate?: number | null
        }
        Relationships: []
      }
      beneficiary_analysis: {
        Row: {
          analyzed_at: string | null
          asset: string
          congressional_direction: string | null
          congressional_signals: number | null
          cycle_id: string | null
          follow_the_money_flag: string | null
          id: number
          insider_signal_count: number | null
          most_exposed_parties: Json | null
          narrative_score: number | null
          onchain_score: number | null
          optics_reality_gap: number | null
          primary_beneficiaries: Json | null
          smart_money_direction: string | null
          whale_score_summary: number | null
        }
        Insert: {
          analyzed_at?: string | null
          asset: string
          congressional_direction?: string | null
          congressional_signals?: number | null
          cycle_id?: string | null
          follow_the_money_flag?: string | null
          id?: number
          insider_signal_count?: number | null
          most_exposed_parties?: Json | null
          narrative_score?: number | null
          onchain_score?: number | null
          optics_reality_gap?: number | null
          primary_beneficiaries?: Json | null
          smart_money_direction?: string | null
          whale_score_summary?: number | null
        }
        Update: {
          analyzed_at?: string | null
          asset?: string
          congressional_direction?: string | null
          congressional_signals?: number | null
          cycle_id?: string | null
          follow_the_money_flag?: string | null
          id?: number
          insider_signal_count?: number | null
          most_exposed_parties?: Json | null
          narrative_score?: number | null
          onchain_score?: number | null
          optics_reality_gap?: number | null
          primary_beneficiaries?: Json | null
          smart_money_direction?: string | null
          whale_score_summary?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "beneficiary_analysis_cycle_id_fkey"
            columns: ["cycle_id"]
            isOneToOne: false
            referencedRelation: "prediction_consensus"
            referencedColumns: ["cycle_id"]
          },
        ]
      }
      brain_regions: {
        Row: {
          function_description: string | null
          primary_agent: string | null
          region_name: string
          response_priority: number | null
          secondary_agents: string[] | null
        }
        Insert: {
          function_description?: string | null
          primary_agent?: string | null
          region_name: string
          response_priority?: number | null
          secondary_agents?: string[] | null
        }
        Update: {
          function_description?: string | null
          primary_agent?: string | null
          region_name?: string
          response_priority?: number | null
          secondary_agents?: string[] | null
        }
        Relationships: []
      }
      bubble_migration_events: {
        Row: {
          conservation_gap_pct: number | null
          detected_at: string
          hidden_flow_suspected: boolean | null
          id: number
          lle_at_detection: number | null
          migration_confidence: number | null
          outflow_asset_class: string
          predicted_next_receiver: string | null
          receiving_asset_classes: Json | null
          regime_id: number | null
          risk_appetite_direction: string | null
          total_outflow_usd: number | null
          tracked_inflow_usd: number | null
        }
        Insert: {
          conservation_gap_pct?: number | null
          detected_at?: string
          hidden_flow_suspected?: boolean | null
          id?: number
          lle_at_detection?: number | null
          migration_confidence?: number | null
          outflow_asset_class: string
          predicted_next_receiver?: string | null
          receiving_asset_classes?: Json | null
          regime_id?: number | null
          risk_appetite_direction?: string | null
          total_outflow_usd?: number | null
          tracked_inflow_usd?: number | null
        }
        Update: {
          conservation_gap_pct?: number | null
          detected_at?: string
          hidden_flow_suspected?: boolean | null
          id?: number
          lle_at_detection?: number | null
          migration_confidence?: number | null
          outflow_asset_class?: string
          predicted_next_receiver?: string | null
          receiving_asset_classes?: Json | null
          regime_id?: number | null
          risk_appetite_direction?: string | null
          total_outflow_usd?: number | null
          tracked_inflow_usd?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "bubble_migration_events_regime_id_fkey"
            columns: ["regime_id"]
            isOneToOne: false
            referencedRelation: "prediction_regimes"
            referencedColumns: ["id"]
          },
        ]
      }
      builders: {
        Row: {
          address: string
          agent_count: number | null
          auth_method: string
          created_at: string
          current_repid: number
          display_name: string | null
          earns_repid_rewards: boolean
          email: string | null
          erc7231_token_id: string | null
          ghost_cohort_count: number
          id: string
          last_active_at: string | null
          notification_prefs: Json | null
          password_hash: string | null
          session_token: string | null
          trading_credentials_encrypted: Json | null
          trading_paper_account_id: string | null
          trading_provider: string | null
        }
        Insert: {
          address: string
          agent_count?: number | null
          auth_method?: string
          created_at?: string
          current_repid?: number
          display_name?: string | null
          earns_repid_rewards?: boolean
          email?: string | null
          erc7231_token_id?: string | null
          ghost_cohort_count?: number
          id?: string
          last_active_at?: string | null
          notification_prefs?: Json | null
          password_hash?: string | null
          session_token?: string | null
          trading_credentials_encrypted?: Json | null
          trading_paper_account_id?: string | null
          trading_provider?: string | null
        }
        Update: {
          address?: string
          agent_count?: number | null
          auth_method?: string
          created_at?: string
          current_repid?: number
          display_name?: string | null
          earns_repid_rewards?: boolean
          email?: string | null
          erc7231_token_id?: string | null
          ghost_cohort_count?: number
          id?: string
          last_active_at?: string | null
          notification_prefs?: Json | null
          password_hash?: string | null
          session_token?: string | null
          trading_credentials_encrypted?: Json | null
          trading_paper_account_id?: string | null
          trading_provider?: string | null
        }
        Relationships: []
      }
      call_log: {
        Row: {
          created_at: string | null
          id: string
          latency_ms: number | null
          provider: string | null
          success: boolean | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          latency_ms?: number | null
          provider?: string | null
          success?: boolean | null
        }
        Update: {
          created_at?: string | null
          id?: string
          latency_ms?: number | null
          provider?: string | null
          success?: boolean | null
        }
        Relationships: []
      }
      campaign_cost_tracking: {
        Row: {
          ai_decision_id: string | null
          amount_cents: number
          budget_percentage: number
          campaign_id: string
          cost_type: string
          id: string
          provider: string
          running_total_cents: number
          timestamp: string | null
          transaction_details: Json | null
        }
        Insert: {
          ai_decision_id?: string | null
          amount_cents: number
          budget_percentage: number
          campaign_id: string
          cost_type: string
          id?: string
          provider: string
          running_total_cents: number
          timestamp?: string | null
          transaction_details?: Json | null
        }
        Update: {
          ai_decision_id?: string | null
          amount_cents?: number
          budget_percentage?: number
          campaign_id?: string
          cost_type?: string
          id?: string
          provider?: string
          running_total_cents?: number
          timestamp?: string | null
          transaction_details?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "campaign_cost_tracking_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "automated_campaigns"
            referencedColumns: ["id"]
          },
        ]
      }
      campaign_performance_metrics: {
        Row: {
          ai_prediction: number | null
          campaign_id: string
          contributing_factors: Json | null
          id: string
          learning_applied: boolean | null
          measurement_timestamp: string | null
          metric_type: string
          metric_value: number
          prediction_accuracy: number | null
        }
        Insert: {
          ai_prediction?: number | null
          campaign_id: string
          contributing_factors?: Json | null
          id?: string
          learning_applied?: boolean | null
          measurement_timestamp?: string | null
          metric_type: string
          metric_value: number
          prediction_accuracy?: number | null
        }
        Update: {
          ai_prediction?: number | null
          campaign_id?: string
          contributing_factors?: Json | null
          id?: string
          learning_applied?: boolean | null
          measurement_timestamp?: string | null
          metric_type?: string
          metric_value?: number
          prediction_accuracy?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "campaign_performance_metrics_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "automated_campaigns"
            referencedColumns: ["id"]
          },
        ]
      }
      campaign_safety_events: {
        Row: {
          action_taken: string | null
          ai_agent: string | null
          campaign_id: string
          event_type: string
          human_notified: boolean | null
          id: string
          resolution_details: Json | null
          resolved: boolean | null
          severity: string
          timestamp: string | null
          trigger_details: Json
        }
        Insert: {
          action_taken?: string | null
          ai_agent?: string | null
          campaign_id: string
          event_type: string
          human_notified?: boolean | null
          id?: string
          resolution_details?: Json | null
          resolved?: boolean | null
          severity: string
          timestamp?: string | null
          trigger_details: Json
        }
        Update: {
          action_taken?: string | null
          ai_agent?: string | null
          campaign_id?: string
          event_type?: string
          human_notified?: boolean | null
          id?: string
          resolution_details?: Json | null
          resolved?: boolean | null
          severity?: string
          timestamp?: string | null
          trigger_details?: Json
        }
        Relationships: [
          {
            foreignKeyName: "campaign_safety_events_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "automated_campaigns"
            referencedColumns: ["id"]
          },
        ]
      }
      care_actions: {
        Row: {
          action_type: string
          actor_rep_id: string
          created_at: string | null
          id: number
          metadata: Json | null
          outcome_pending: boolean | null
          outcome_positive: boolean | null
          session_id: string | null
          updated_at: string | null
        }
        Insert: {
          action_type: string
          actor_rep_id?: string
          created_at?: string | null
          id?: number
          metadata?: Json | null
          outcome_pending?: boolean | null
          outcome_positive?: boolean | null
          session_id?: string | null
          updated_at?: string | null
        }
        Update: {
          action_type?: string
          actor_rep_id?: string
          created_at?: string | null
          id?: number
          metadata?: Json | null
          outcome_pending?: boolean | null
          outcome_positive?: boolean | null
          session_id?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      chaos_events: {
        Row: {
          action_taken: string
          chaos_type: string
          created_at: string | null
          id: number
          improvement_suggestion: string | null
          recovery_completed_at: string | null
          recovery_method: string | null
          recovery_started_at: string | null
          recovery_success: boolean | null
          resilience_score: number | null
          target_agent: string | null
          target_task_id: number | null
        }
        Insert: {
          action_taken: string
          chaos_type: string
          created_at?: string | null
          id?: number
          improvement_suggestion?: string | null
          recovery_completed_at?: string | null
          recovery_method?: string | null
          recovery_started_at?: string | null
          recovery_success?: boolean | null
          resilience_score?: number | null
          target_agent?: string | null
          target_task_id?: number | null
        }
        Update: {
          action_taken?: string
          chaos_type?: string
          created_at?: string | null
          id?: number
          improvement_suggestion?: string | null
          recovery_completed_at?: string | null
          recovery_method?: string | null
          recovery_started_at?: string | null
          recovery_success?: boolean | null
          resilience_score?: number | null
          target_agent?: string | null
          target_task_id?: number | null
        }
        Relationships: []
      }
      circuit_breakers: {
        Row: {
          failure_count: number | null
          half_open_at: string | null
          id: string
          last_failure_at: string | null
          last_success_at: string | null
          opened_at: string | null
          reset_timeout_minutes: number | null
          state: string | null
          success_count: number | null
          threshold_failures: number | null
          updated_at: string | null
        }
        Insert: {
          failure_count?: number | null
          half_open_at?: string | null
          id: string
          last_failure_at?: string | null
          last_success_at?: string | null
          opened_at?: string | null
          reset_timeout_minutes?: number | null
          state?: string | null
          success_count?: number | null
          threshold_failures?: number | null
          updated_at?: string | null
        }
        Update: {
          failure_count?: number | null
          half_open_at?: string | null
          id?: string
          last_failure_at?: string | null
          last_success_at?: string | null
          opened_at?: string | null
          reset_timeout_minutes?: number | null
          state?: string | null
          success_count?: number | null
          threshold_failures?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      clashy_waitlist: {
        Row: {
          created_at: string | null
          email: string
          id: string
        }
        Insert: {
          created_at?: string | null
          email: string
          id?: string
        }
        Update: {
          created_at?: string | null
          email?: string
          id?: string
        }
        Relationships: []
      }
      claude_session_log: {
        Row: {
          context_summary: string | null
          created_at: string | null
          id: number
          key_decisions: string[] | null
          next_session_priorities: string[] | null
          session_date: string | null
          session_type: string | null
          tasks_dispatched: number | null
        }
        Insert: {
          context_summary?: string | null
          created_at?: string | null
          id?: number
          key_decisions?: string[] | null
          next_session_priorities?: string[] | null
          session_date?: string | null
          session_type?: string | null
          tasks_dispatched?: number | null
        }
        Update: {
          context_summary?: string | null
          created_at?: string | null
          id?: number
          key_decisions?: string[] | null
          next_session_priorities?: string[] | null
          session_date?: string | null
          session_type?: string | null
          tasks_dispatched?: number | null
        }
        Relationships: []
      }
      community_waitlist: {
        Row: {
          actions_completed: Json | null
          created_at: string | null
          dbt_token_id: string | null
          email: string
          id: string
          id_verified: boolean | null
          phone_verified: boolean | null
          points_earned: number | null
          referral_code: string | null
          referred_by: string | null
          rep_id_score: number | null
          sbt_token_id: string | null
          stage: number | null
          updated_at: string | null
          wallet_address: string | null
          wallet_connected: boolean | null
          zkp_proof_hash: string | null
        }
        Insert: {
          actions_completed?: Json | null
          created_at?: string | null
          dbt_token_id?: string | null
          email: string
          id?: string
          id_verified?: boolean | null
          phone_verified?: boolean | null
          points_earned?: number | null
          referral_code?: string | null
          referred_by?: string | null
          rep_id_score?: number | null
          sbt_token_id?: string | null
          stage?: number | null
          updated_at?: string | null
          wallet_address?: string | null
          wallet_connected?: boolean | null
          zkp_proof_hash?: string | null
        }
        Update: {
          actions_completed?: Json | null
          created_at?: string | null
          dbt_token_id?: string | null
          email?: string
          id?: string
          id_verified?: boolean | null
          phone_verified?: boolean | null
          points_earned?: number | null
          referral_code?: string | null
          referred_by?: string | null
          rep_id_score?: number | null
          sbt_token_id?: string | null
          stage?: number | null
          updated_at?: string | null
          wallet_address?: string | null
          wallet_connected?: boolean | null
          zkp_proof_hash?: string | null
        }
        Relationships: []
      }
      compute_bids: {
        Row: {
          accuracy_score: number | null
          agent_id: string
          agent_repid_score: number | null
          bid_type: string
          cost_estimate: number | null
          decided_at: string
          id: number
          is_winner: boolean | null
          latency_estimate_ms: number | null
          provider: string | null
          stewardship_weight: number | null
          task_id: number | null
        }
        Insert: {
          accuracy_score?: number | null
          agent_id: string
          agent_repid_score?: number | null
          bid_type: string
          cost_estimate?: number | null
          decided_at?: string
          id?: number
          is_winner?: boolean | null
          latency_estimate_ms?: number | null
          provider?: string | null
          stewardship_weight?: number | null
          task_id?: number | null
        }
        Update: {
          accuracy_score?: number | null
          agent_id?: string
          agent_repid_score?: number | null
          bid_type?: string
          cost_estimate?: number | null
          decided_at?: string
          id?: number
          is_winner?: boolean | null
          latency_estimate_ms?: number | null
          provider?: string | null
          stewardship_weight?: number | null
          task_id?: number | null
        }
        Relationships: []
      }
      conductor_sessions: {
        Row: {
          challenges_initiated: number | null
          challenges_received: number | null
          conductor: string
          config_changes: Json | null
          ended_at: string | null
          id: string
          rotation_minutes_used: number | null
          started_at: string | null
          tasks_completed: number | null
        }
        Insert: {
          challenges_initiated?: number | null
          challenges_received?: number | null
          conductor: string
          config_changes?: Json | null
          ended_at?: string | null
          id?: string
          rotation_minutes_used?: number | null
          started_at?: string | null
          tasks_completed?: number | null
        }
        Update: {
          challenges_initiated?: number | null
          challenges_received?: number | null
          conductor?: string
          config_changes?: Json | null
          ended_at?: string | null
          id?: string
          rotation_minutes_used?: number | null
          started_at?: string | null
          tasks_completed?: number | null
        }
        Relationships: []
      }
      conductor_state: {
        Row: {
          capabilities: Json | null
          conductor_id: string
          created_at: string | null
          current_task_id: number | null
          entropy_budget: number | null
          entropy_used_today: number | null
          external_artifacts_created: number | null
          last_entropy_reset: string | null
          last_heartbeat: string | null
          preferred_providers: Json | null
          reputation_score: number | null
          specialization_scores: Json | null
          status: string | null
          tasks_completed: number | null
          tasks_failed: number | null
          updated_at: string | null
        }
        Insert: {
          capabilities?: Json | null
          conductor_id: string
          created_at?: string | null
          current_task_id?: number | null
          entropy_budget?: number | null
          entropy_used_today?: number | null
          external_artifacts_created?: number | null
          last_entropy_reset?: string | null
          last_heartbeat?: string | null
          preferred_providers?: Json | null
          reputation_score?: number | null
          specialization_scores?: Json | null
          status?: string | null
          tasks_completed?: number | null
          tasks_failed?: number | null
          updated_at?: string | null
        }
        Update: {
          capabilities?: Json | null
          conductor_id?: string
          created_at?: string | null
          current_task_id?: number | null
          entropy_budget?: number | null
          entropy_used_today?: number | null
          external_artifacts_created?: number | null
          last_entropy_reset?: string | null
          last_heartbeat?: string | null
          preferred_providers?: Json | null
          reputation_score?: number | null
          specialization_scores?: Json | null
          status?: string | null
          tasks_completed?: number | null
          tasks_failed?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      confidence_stakes: {
        Row: {
          actual_outcome: number | null
          agent_name: string
          calibration_delta: number | null
          confidence_declared: number | null
          created_at: string | null
          id: number
          task_id: number | null
        }
        Insert: {
          actual_outcome?: number | null
          agent_name: string
          calibration_delta?: number | null
          confidence_declared?: number | null
          created_at?: string | null
          id?: number
          task_id?: number | null
        }
        Update: {
          actual_outcome?: number | null
          agent_name?: string
          calibration_delta?: number | null
          confidence_declared?: number | null
          created_at?: string | null
          id?: number
          task_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "confidence_stakes_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "trinity_post_task_lag"
            referencedColumns: ["task_id"]
          },
          {
            foreignKeyName: "confidence_stakes_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "trinity_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      config_change_proposals: {
        Row: {
          auto_proposed: boolean | null
          config_key: string
          created_at: string | null
          current_value: number | null
          id: string
          proposed_by: string
          proposed_value: number | null
          reason: string | null
          resolved_at: string | null
          status: string | null
          votes_against: string[] | null
          votes_for: string[] | null
        }
        Insert: {
          auto_proposed?: boolean | null
          config_key: string
          created_at?: string | null
          current_value?: number | null
          id?: string
          proposed_by: string
          proposed_value?: number | null
          reason?: string | null
          resolved_at?: string | null
          status?: string | null
          votes_against?: string[] | null
          votes_for?: string[] | null
        }
        Update: {
          auto_proposed?: boolean | null
          config_key?: string
          created_at?: string | null
          current_value?: number | null
          id?: string
          proposed_by?: string
          proposed_value?: number | null
          reason?: string | null
          resolved_at?: string | null
          status?: string | null
          votes_against?: string[] | null
          votes_for?: string[] | null
        }
        Relationships: []
      }
      controller_state: {
        Row: {
          focus_mode: string | null
          id: number
          max_active_agents: number | null
          resource_allocation: Json | null
          rotation_hours: number | null
          updated_at: string | null
        }
        Insert: {
          focus_mode?: string | null
          id?: number
          max_active_agents?: number | null
          resource_allocation?: Json | null
          rotation_hours?: number | null
          updated_at?: string | null
        }
        Update: {
          focus_mode?: string | null
          id?: number
          max_active_agents?: number | null
          resource_allocation?: Json | null
          rotation_hours?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      conversations: {
        Row: {
          ai_model_used: string | null
          context_data: Json | null
          created_at: string
          id: string
          message: string
          response: string
          user_id: string
        }
        Insert: {
          ai_model_used?: string | null
          context_data?: Json | null
          created_at?: string
          id?: string
          message: string
          response: string
          user_id: string
        }
        Update: {
          ai_model_used?: string | null
          context_data?: Json | null
          created_at?: string
          id?: string
          message?: string
          response?: string
          user_id?: string
        }
        Relationships: []
      }
      cost_tracking: {
        Row: {
          api_calls_count: number | null
          created_at: string | null
          date: string | null
          id: string
          task_count: number | null
          traditional_cost: number | null
          trinity_cost: number | null
        }
        Insert: {
          api_calls_count?: number | null
          created_at?: string | null
          date?: string | null
          id?: string
          task_count?: number | null
          traditional_cost?: number | null
          trinity_cost?: number | null
        }
        Update: {
          api_calls_count?: number | null
          created_at?: string | null
          date?: string | null
          id?: string
          task_count?: number | null
          traditional_cost?: number | null
          trinity_cost?: number | null
        }
        Relationships: []
      }
      cross_ai_messages: {
        Row: {
          created_at: string | null
          id: number
          message: string
          recipient: string
          sender: string
          task_hash: string | null
        }
        Insert: {
          created_at?: string | null
          id?: number
          message: string
          recipient: string
          sender: string
          task_hash?: string | null
        }
        Update: {
          created_at?: string | null
          id?: number
          message?: string
          recipient?: string
          sender?: string
          task_hash?: string | null
        }
        Relationships: []
      }
      cross_llm_comparisons: {
        Row: {
          agreement_score: number
          answer_1_preview: string | null
          answer_2_preview: string | null
          comma_gap: number | null
          comma_severity: string | null
          comma_veto: boolean
          created_at: string
          embedding_distance: number
          id: number
          latency_ms: number
          methodology: string
          model_1: string | null
          model_2: string | null
          prompt_hash: string
          provider_1: string | null
          provider_2: string | null
          provider_count: number | null
          provider_responses: Json | null
        }
        Insert: {
          agreement_score: number
          answer_1_preview?: string | null
          answer_2_preview?: string | null
          comma_gap?: number | null
          comma_severity?: string | null
          comma_veto?: boolean
          created_at?: string
          embedding_distance: number
          id?: number
          latency_ms: number
          methodology: string
          model_1?: string | null
          model_2?: string | null
          prompt_hash: string
          provider_1?: string | null
          provider_2?: string | null
          provider_count?: number | null
          provider_responses?: Json | null
        }
        Update: {
          agreement_score?: number
          answer_1_preview?: string | null
          answer_2_preview?: string | null
          comma_gap?: number | null
          comma_severity?: string | null
          comma_veto?: boolean
          created_at?: string
          embedding_distance?: number
          id?: number
          latency_ms?: number
          methodology?: string
          model_1?: string | null
          model_2?: string | null
          prompt_hash?: string
          provider_1?: string | null
          provider_2?: string | null
          provider_count?: number | null
          provider_responses?: Json | null
        }
        Relationships: []
      }
      customer_feedback: {
        Row: {
          actionable_insights: string[] | null
          assigned_agent: string | null
          created_at: string | null
          feedback_type: string | null
          id: number
          project_name: string
          raw_feedback: string | null
          sentiment: string | null
          status: string | null
          summary: string
        }
        Insert: {
          actionable_insights?: string[] | null
          assigned_agent?: string | null
          created_at?: string | null
          feedback_type?: string | null
          id?: number
          project_name: string
          raw_feedback?: string | null
          sentiment?: string | null
          status?: string | null
          summary: string
        }
        Update: {
          actionable_insights?: string[] | null
          assigned_agent?: string | null
          created_at?: string | null
          feedback_type?: string | null
          id?: number
          project_name?: string
          raw_feedback?: string | null
          sentiment?: string | null
          status?: string | null
          summary?: string
        }
        Relationships: []
      }
      dag_edges: {
        Row: {
          created_at: string | null
          edge_label: string | null
          id: number
          source_hash: string | null
          target_hash: string | null
          weight: number | null
        }
        Insert: {
          created_at?: string | null
          edge_label?: string | null
          id?: number
          source_hash?: string | null
          target_hash?: string | null
          weight?: number | null
        }
        Update: {
          created_at?: string | null
          edge_label?: string | null
          id?: number
          source_hash?: string | null
          target_hash?: string | null
          weight?: number | null
        }
        Relationships: []
      }
      dag_nodes: {
        Row: {
          agent_owner: string | null
          content_hash: string | null
          created_at: string | null
          embedding: string | null
          id: string
          node_type: string | null
          sprint_id: number | null
        }
        Insert: {
          agent_owner?: string | null
          content_hash?: string | null
          created_at?: string | null
          embedding?: string | null
          id: string
          node_type?: string | null
          sprint_id?: number | null
        }
        Update: {
          agent_owner?: string | null
          content_hash?: string | null
          created_at?: string | null
          embedding?: string | null
          id?: string
          node_type?: string | null
          sprint_id?: number | null
        }
        Relationships: []
      }
      daily_costs: {
        Row: {
          budget_limit: number | null
          budget_remaining: number | null
          cost_by_agent: Json | null
          cost_by_provider: Json | null
          date: string
          tasks_completed: number | null
          total_cost: number | null
        }
        Insert: {
          budget_limit?: number | null
          budget_remaining?: number | null
          cost_by_agent?: Json | null
          cost_by_provider?: Json | null
          date: string
          tasks_completed?: number | null
          total_cost?: number | null
        }
        Update: {
          budget_limit?: number | null
          budget_remaining?: number | null
          cost_by_agent?: Json | null
          cost_by_provider?: Json | null
          date?: string
          tasks_completed?: number | null
          total_cost?: number | null
        }
        Relationships: []
      }
      daily_exposure_tracker: {
        Row: {
          agent_name: string
          date_utc: string
          id: number
          institution_id: string
          last_updated: string | null
          total_usdc_sent: number | null
          transaction_count: number | null
        }
        Insert: {
          agent_name: string
          date_utc?: string
          id?: number
          institution_id: string
          last_updated?: string | null
          total_usdc_sent?: number | null
          transaction_count?: number | null
        }
        Update: {
          agent_name?: string
          date_utc?: string
          id?: number
          institution_id?: string
          last_updated?: string | null
          total_usdc_sent?: number | null
          transaction_count?: number | null
        }
        Relationships: []
      }
      db_routing_decisions: {
        Row: {
          agent_id: string | null
          confidence: number | null
          decided_at: string | null
          id: number
          latency_budget_ms: number | null
          metadata: Json | null
          query_type: string | null
          tier_selected: string | null
        }
        Insert: {
          agent_id?: string | null
          confidence?: number | null
          decided_at?: string | null
          id?: number
          latency_budget_ms?: number | null
          metadata?: Json | null
          query_type?: string | null
          tier_selected?: string | null
        }
        Update: {
          agent_id?: string | null
          confidence?: number | null
          decided_at?: string | null
          id?: number
          latency_budget_ms?: number | null
          metadata?: Json | null
          query_type?: string | null
          tier_selected?: string | null
        }
        Relationships: []
      }
      db_tier_latency: {
        Row: {
          id: number
          measured_at: string | null
          p50_ms: number | null
          p95_ms: number | null
          p99_ms: number | null
          source: string | null
          tier: string | null
        }
        Insert: {
          id?: number
          measured_at?: string | null
          p50_ms?: number | null
          p95_ms?: number | null
          p99_ms?: number | null
          source?: string | null
          tier?: string | null
        }
        Update: {
          id?: number
          measured_at?: string | null
          p50_ms?: number | null
          p95_ms?: number | null
          p99_ms?: number | null
          source?: string | null
          tier?: string | null
        }
        Relationships: []
      }
      dbt_registry: {
        Row: {
          biometric_hash: string | null
          converted_at: string | null
          converted_to_sbt_id: string | null
          created_at: string | null
          email_hash: string | null
          factors_verified: number | null
          id: number
          institution_id: string | null
          last_pol_attempt: string | null
          phone_hash: string | null
          pol_attempts: number | null
          status: string | null
          token_id: string
          wallet_address: string
        }
        Insert: {
          biometric_hash?: string | null
          converted_at?: string | null
          converted_to_sbt_id?: string | null
          created_at?: string | null
          email_hash?: string | null
          factors_verified?: number | null
          id?: number
          institution_id?: string | null
          last_pol_attempt?: string | null
          phone_hash?: string | null
          pol_attempts?: number | null
          status?: string | null
          token_id: string
          wallet_address: string
        }
        Update: {
          biometric_hash?: string | null
          converted_at?: string | null
          converted_to_sbt_id?: string | null
          created_at?: string | null
          email_hash?: string | null
          factors_verified?: number | null
          id?: number
          institution_id?: string | null
          last_pol_attempt?: string | null
          phone_hash?: string | null
          pol_attempts?: number | null
          status?: string | null
          token_id?: string
          wallet_address?: string
        }
        Relationships: [
          {
            foreignKeyName: "dbt_registry_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institution_config"
            referencedColumns: ["institution_id"]
          },
        ]
      }
      debates: {
        Row: {
          completed_at: string | null
          consensus_confidence: number | null
          created_at: string | null
          id: number
          model_a_response: string | null
          model_a_votes: number | null
          model_b_response: string | null
          model_b_votes: number | null
          model_c_response: string | null
          model_c_votes: number | null
          status: string | null
          topic_id: number | null
          total_shares: number | null
          total_views: number | null
          voting_ends_at: string | null
          winner: string | null
        }
        Insert: {
          completed_at?: string | null
          consensus_confidence?: number | null
          created_at?: string | null
          id?: number
          model_a_response?: string | null
          model_a_votes?: number | null
          model_b_response?: string | null
          model_b_votes?: number | null
          model_c_response?: string | null
          model_c_votes?: number | null
          status?: string | null
          topic_id?: number | null
          total_shares?: number | null
          total_views?: number | null
          voting_ends_at?: string | null
          winner?: string | null
        }
        Update: {
          completed_at?: string | null
          consensus_confidence?: number | null
          created_at?: string | null
          id?: number
          model_a_response?: string | null
          model_a_votes?: number | null
          model_b_response?: string | null
          model_b_votes?: number | null
          model_c_response?: string | null
          model_c_votes?: number | null
          status?: string | null
          topic_id?: number | null
          total_shares?: number | null
          total_views?: number | null
          voting_ends_at?: string | null
          winner?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "debates_topic_id_fkey"
            columns: ["topic_id"]
            isOneToOne: false
            referencedRelation: "aidebate_topics"
            referencedColumns: ["id"]
          },
        ]
      }
      debug_log: {
        Row: {
          created_at: string | null
          id: number
          msg: string | null
        }
        Insert: {
          created_at?: string | null
          id?: number
          msg?: string | null
        }
        Update: {
          created_at?: string | null
          id?: number
          msg?: string | null
        }
        Relationships: []
      }
      decision_log: {
        Row: {
          decision: string
          decision_maker: string
          decision_type: string | null
          id: string
          reasoning: string | null
          repid_impact: number | null
          timestamp: string | null
        }
        Insert: {
          decision: string
          decision_maker: string
          decision_type?: string | null
          id?: string
          reasoning?: string | null
          repid_impact?: number | null
          timestamp?: string | null
        }
        Update: {
          decision?: string
          decision_maker?: string
          decision_type?: string | null
          id?: string
          reasoning?: string | null
          repid_impact?: number | null
          timestamp?: string | null
        }
        Relationships: []
      }
      decision_records: {
        Row: {
          alignment_score: number | null
          claude_confidence: number | null
          claude_position: string | null
          contrarian_concerns: string[] | null
          decided_at: string | null
          decision_question: string
          final_decision: string | null
          grok_confidence: number | null
          grok_position: string | null
          id: string
          outcome_notes: string | null
          outcome_verified: boolean | null
          sdr_number: string
          verified_at: string | null
        }
        Insert: {
          alignment_score?: number | null
          claude_confidence?: number | null
          claude_position?: string | null
          contrarian_concerns?: string[] | null
          decided_at?: string | null
          decision_question: string
          final_decision?: string | null
          grok_confidence?: number | null
          grok_position?: string | null
          id?: string
          outcome_notes?: string | null
          outcome_verified?: boolean | null
          sdr_number: string
          verified_at?: string | null
        }
        Update: {
          alignment_score?: number | null
          claude_confidence?: number | null
          claude_position?: string | null
          contrarian_concerns?: string[] | null
          decided_at?: string | null
          decision_question?: string
          final_decision?: string | null
          grok_confidence?: number | null
          grok_position?: string | null
          id?: string
          outcome_notes?: string | null
          outcome_verified?: boolean | null
          sdr_number?: string
          verified_at?: string | null
        }
        Relationships: []
      }
      defect_4_validation_log: {
        Row: {
          actual_verdict: string | null
          comma_gap_observed: number | null
          contract_id: string | null
          created_at: string | null
          expected_verdict: string | null
          id: string
          notes: string | null
          observation_type: string
          observer_agent: string
          pcp_confidence_observed: number | null
          requires_human_review: boolean | null
          reviewed_at: string | null
          reviewed_by: string | null
        }
        Insert: {
          actual_verdict?: string | null
          comma_gap_observed?: number | null
          contract_id?: string | null
          created_at?: string | null
          expected_verdict?: string | null
          id?: string
          notes?: string | null
          observation_type: string
          observer_agent: string
          pcp_confidence_observed?: number | null
          requires_human_review?: boolean | null
          reviewed_at?: string | null
          reviewed_by?: string | null
        }
        Update: {
          actual_verdict?: string | null
          comma_gap_observed?: number | null
          contract_id?: string | null
          created_at?: string | null
          expected_verdict?: string | null
          id?: string
          notes?: string | null
          observation_type?: string
          observer_agent?: string
          pcp_confidence_observed?: number | null
          requires_human_review?: boolean | null
          reviewed_at?: string | null
          reviewed_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "defect_4_validation_log_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "cascade_telemetry_v1"
            referencedColumns: ["contract_id"]
          },
          {
            foreignKeyName: "defect_4_validation_log_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "service_contracts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "defect_4_validation_log_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "v_cascade_baseline_2026_05_18"
            referencedColumns: ["contract_id"]
          },
        ]
      }
      demo_sessions: {
        Row: {
          conductor_id: string | null
          created_at: string | null
          ended_at: string | null
          id: string
          invite_id: string | null
          peak_viewers: number | null
          session_code: string
          session_name: string | null
          status: string | null
          viewer_count: number | null
        }
        Insert: {
          conductor_id?: string | null
          created_at?: string | null
          ended_at?: string | null
          id?: string
          invite_id?: string | null
          peak_viewers?: number | null
          session_code: string
          session_name?: string | null
          status?: string | null
          viewer_count?: number | null
        }
        Update: {
          conductor_id?: string | null
          created_at?: string | null
          ended_at?: string | null
          id?: string
          invite_id?: string | null
          peak_viewers?: number | null
          session_code?: string
          session_name?: string | null
          status?: string | null
          viewer_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "demo_sessions_invite_id_fkey"
            columns: ["invite_id"]
            isOneToOne: false
            referencedRelation: "invites"
            referencedColumns: ["id"]
          },
        ]
      }
      demo_viewers: {
        Row: {
          engagement_score: number | null
          id: string
          invite_id: string | null
          is_active: boolean | null
          is_first_visit: boolean | null
          joined_at: string | null
          journey: Json | null
          last_seen: string | null
          sections_viewed: string[] | null
          session_id: string | null
          time_on_demo: number | null
          verified_user_id: string | null
          viewer_category: string | null
          viewer_name: string | null
        }
        Insert: {
          engagement_score?: number | null
          id?: string
          invite_id?: string | null
          is_active?: boolean | null
          is_first_visit?: boolean | null
          joined_at?: string | null
          journey?: Json | null
          last_seen?: string | null
          sections_viewed?: string[] | null
          session_id?: string | null
          time_on_demo?: number | null
          verified_user_id?: string | null
          viewer_category?: string | null
          viewer_name?: string | null
        }
        Update: {
          engagement_score?: number | null
          id?: string
          invite_id?: string | null
          is_active?: boolean | null
          is_first_visit?: boolean | null
          joined_at?: string | null
          journey?: Json | null
          last_seen?: string | null
          sections_viewed?: string[] | null
          session_id?: string | null
          time_on_demo?: number | null
          verified_user_id?: string | null
          viewer_category?: string | null
          viewer_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "demo_viewers_invite_id_fkey"
            columns: ["invite_id"]
            isOneToOne: false
            referencedRelation: "invites"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "demo_viewers_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "demo_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "demo_viewers_verified_user_id_fkey"
            columns: ["verified_user_id"]
            isOneToOne: false
            referencedRelation: "verified_users"
            referencedColumns: ["id"]
          },
        ]
      }
      demo_views: {
        Row: {
          challenge_submitted: boolean | null
          challenge_text: string | null
          created_at: string | null
          deepest_section: string | null
          follow_up_score: number | null
          id: string
          investor_category: string | null
          ip_hash: string | null
          opted_in_to_signal: boolean | null
          questions_asked: string[] | null
          sections_viewed: string[] | null
          session_id: string | null
          signal_unlocked: boolean | null
          time_on_demo: number | null
          updated_at: string | null
          user_agent: string | null
          verification_method: string | null
          verified_user_id: string | null
          viewer_company: string | null
          viewer_email: string | null
          viewer_id: string | null
          viewer_name: string | null
        }
        Insert: {
          challenge_submitted?: boolean | null
          challenge_text?: string | null
          created_at?: string | null
          deepest_section?: string | null
          follow_up_score?: number | null
          id?: string
          investor_category?: string | null
          ip_hash?: string | null
          opted_in_to_signal?: boolean | null
          questions_asked?: string[] | null
          sections_viewed?: string[] | null
          session_id?: string | null
          signal_unlocked?: boolean | null
          time_on_demo?: number | null
          updated_at?: string | null
          user_agent?: string | null
          verification_method?: string | null
          verified_user_id?: string | null
          viewer_company?: string | null
          viewer_email?: string | null
          viewer_id?: string | null
          viewer_name?: string | null
        }
        Update: {
          challenge_submitted?: boolean | null
          challenge_text?: string | null
          created_at?: string | null
          deepest_section?: string | null
          follow_up_score?: number | null
          id?: string
          investor_category?: string | null
          ip_hash?: string | null
          opted_in_to_signal?: boolean | null
          questions_asked?: string[] | null
          sections_viewed?: string[] | null
          session_id?: string | null
          signal_unlocked?: boolean | null
          time_on_demo?: number | null
          updated_at?: string | null
          user_agent?: string | null
          verification_method?: string | null
          verified_user_id?: string | null
          viewer_company?: string | null
          viewer_email?: string | null
          viewer_id?: string | null
          viewer_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "demo_views_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "demo_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "demo_views_verified_user_id_fkey"
            columns: ["verified_user_id"]
            isOneToOne: false
            referencedRelation: "verified_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "demo_views_viewer_id_fkey"
            columns: ["viewer_id"]
            isOneToOne: false
            referencedRelation: "demo_viewers"
            referencedColumns: ["id"]
          },
        ]
      }
      design_decisions: {
        Row: {
          claude_proposed: string | null
          composer_approved: boolean | null
          decided_at: string | null
          decision_title: string
          final_implementation: string | null
          grok_refined: string | null
          id: string
          implemented_at: string | null
          notes: string | null
          patent_relevant: boolean | null
          repid_impact: string | null
        }
        Insert: {
          claude_proposed?: string | null
          composer_approved?: boolean | null
          decided_at?: string | null
          decision_title: string
          final_implementation?: string | null
          grok_refined?: string | null
          id?: string
          implemented_at?: string | null
          notes?: string | null
          patent_relevant?: boolean | null
          repid_impact?: string | null
        }
        Update: {
          claude_proposed?: string | null
          composer_approved?: boolean | null
          decided_at?: string | null
          decision_title?: string
          final_implementation?: string | null
          grok_refined?: string | null
          id?: string
          implemented_at?: string | null
          notes?: string | null
          patent_relevant?: boolean | null
          repid_impact?: string | null
        }
        Relationships: []
      }
      developer_waitlist: {
        Row: {
          created_at: string | null
          email: string
          github_handle: string | null
          id: number
          linkedin_url: string | null
          name: string | null
          repid_seed: number | null
          role_type: string | null
          spot_number: number | null
          status: string | null
          why_interested: string | null
        }
        Insert: {
          created_at?: string | null
          email: string
          github_handle?: string | null
          id?: number
          linkedin_url?: string | null
          name?: string | null
          repid_seed?: number | null
          role_type?: string | null
          spot_number?: number | null
          status?: string | null
          why_interested?: string | null
        }
        Update: {
          created_at?: string | null
          email?: string
          github_handle?: string | null
          id?: number
          linkedin_url?: string | null
          name?: string | null
          repid_seed?: number | null
          role_type?: string | null
          spot_number?: number | null
          status?: string | null
          why_interested?: string | null
        }
        Relationships: []
      }
      dispute_validation_queue: {
        Row: {
          contract_id: string
          created_at: string | null
          id: string
          judge_confidence: number | null
          judge_verdict: string | null
          metadata: Json | null
          pcp_score: number | null
          processed_at: string | null
          status: string
          validator_agents: string[] | null
          worker_verdict: string | null
        }
        Insert: {
          contract_id: string
          created_at?: string | null
          id?: string
          judge_confidence?: number | null
          judge_verdict?: string | null
          metadata?: Json | null
          pcp_score?: number | null
          processed_at?: string | null
          status?: string
          validator_agents?: string[] | null
          worker_verdict?: string | null
        }
        Update: {
          contract_id?: string
          created_at?: string | null
          id?: string
          judge_confidence?: number | null
          judge_verdict?: string | null
          metadata?: Json | null
          pcp_score?: number | null
          processed_at?: string | null
          status?: string
          validator_agents?: string[] | null
          worker_verdict?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "dispute_validation_queue_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "cascade_telemetry_v1"
            referencedColumns: ["contract_id"]
          },
          {
            foreignKeyName: "dispute_validation_queue_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "service_contracts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dispute_validation_queue_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "v_cascade_baseline_2026_05_18"
            referencedColumns: ["contract_id"]
          },
        ]
      }
      divergence_metrics: {
        Row: {
          agent_id: string
          conservator_candidate: boolean | null
          created_at: string | null
          divergence_score: number | null
          followed_sophia: boolean | null
          followed_user_agent: boolean | null
          id: number
          message_type: string | null
          notes: string | null
          signal_was_correct: boolean | null
          sophia_repid_snapshot: number | null
          sophia_verdict: string | null
          user_agent_id: number | null
          user_agent_verdict: string | null
          user_followed_signal: boolean | null
          user_outcome: string | null
          user_session_id: string | null
        }
        Insert: {
          agent_id?: string
          conservator_candidate?: boolean | null
          created_at?: string | null
          divergence_score?: number | null
          followed_sophia?: boolean | null
          followed_user_agent?: boolean | null
          id?: number
          message_type?: string | null
          notes?: string | null
          signal_was_correct?: boolean | null
          sophia_repid_snapshot?: number | null
          sophia_verdict?: string | null
          user_agent_id?: number | null
          user_agent_verdict?: string | null
          user_followed_signal?: boolean | null
          user_outcome?: string | null
          user_session_id?: string | null
        }
        Update: {
          agent_id?: string
          conservator_candidate?: boolean | null
          created_at?: string | null
          divergence_score?: number | null
          followed_sophia?: boolean | null
          followed_user_agent?: boolean | null
          id?: number
          message_type?: string | null
          notes?: string | null
          signal_was_correct?: boolean | null
          sophia_repid_snapshot?: number | null
          sophia_verdict?: string | null
          user_agent_id?: number | null
          user_agent_verdict?: string | null
          user_followed_signal?: boolean | null
          user_outcome?: string | null
          user_session_id?: string | null
        }
        Relationships: []
      }
      dual_signature_policy: {
        Row: {
          board_required_above: number | null
          compliance_authority_roles: string[] | null
          dual_sig_for_config_changes: boolean | null
          dual_sig_for_limit_increase: boolean | null
          dual_sig_for_tier_upgrade: boolean | null
          dual_sig_for_vault_creation: boolean | null
          dual_sig_required_above: number | null
          financial_authority_roles: string[] | null
          id: number
          institution_id: string
          single_sig_max_usdc: number | null
          technical_authority_roles: string[] | null
          updated_at: string | null
        }
        Insert: {
          board_required_above?: number | null
          compliance_authority_roles?: string[] | null
          dual_sig_for_config_changes?: boolean | null
          dual_sig_for_limit_increase?: boolean | null
          dual_sig_for_tier_upgrade?: boolean | null
          dual_sig_for_vault_creation?: boolean | null
          dual_sig_required_above?: number | null
          financial_authority_roles?: string[] | null
          id?: number
          institution_id?: string
          single_sig_max_usdc?: number | null
          technical_authority_roles?: string[] | null
          updated_at?: string | null
        }
        Update: {
          board_required_above?: number | null
          compliance_authority_roles?: string[] | null
          dual_sig_for_config_changes?: boolean | null
          dual_sig_for_limit_increase?: boolean | null
          dual_sig_for_tier_upgrade?: boolean | null
          dual_sig_for_vault_creation?: boolean | null
          dual_sig_required_above?: number | null
          financial_authority_roles?: string[] | null
          id?: number
          institution_id?: string
          single_sig_max_usdc?: number | null
          technical_authority_roles?: string[] | null
          updated_at?: string | null
        }
        Relationships: []
      }
      ecosystem_apps: {
        Row: {
          category: string | null
          created_at: string | null
          current_agent: string | null
          current_task: string | null
          description: string | null
          display_order: number | null
          icon_emoji: string | null
          id: string
          name: string
          slug: string
          status: string | null
          tagline: string | null
          url: string | null
        }
        Insert: {
          category?: string | null
          created_at?: string | null
          current_agent?: string | null
          current_task?: string | null
          description?: string | null
          display_order?: number | null
          icon_emoji?: string | null
          id?: string
          name: string
          slug: string
          status?: string | null
          tagline?: string | null
          url?: string | null
        }
        Update: {
          category?: string | null
          created_at?: string | null
          current_agent?: string | null
          current_task?: string | null
          description?: string | null
          display_order?: number | null
          icon_emoji?: string | null
          id?: string
          name?: string
          slug?: string
          status?: string | null
          tagline?: string | null
          url?: string | null
        }
        Relationships: []
      }
      email_captures: {
        Row: {
          captured_at: string
          email: string
          id: string
          metadata: Json | null
          source: string | null
        }
        Insert: {
          captured_at?: string
          email: string
          id?: string
          metadata?: Json | null
          source?: string | null
        }
        Update: {
          captured_at?: string
          email?: string
          id?: string
          metadata?: Json | null
          source?: string | null
        }
        Relationships: []
      }
      energy_log: {
        Row: {
          blockers: string[] | null
          caffeine_intake: number | null
          energy_level: number
          exercise_today: boolean | null
          focus_capacity: string | null
          id: number
          logged_at: string | null
          mood: string | null
          notes: string | null
          recommended_task_type: string | null
          sleep_hours_previous: number | null
          tasks_completed_after: number | null
          time_of_day: string | null
        }
        Insert: {
          blockers?: string[] | null
          caffeine_intake?: number | null
          energy_level: number
          exercise_today?: boolean | null
          focus_capacity?: string | null
          id?: number
          logged_at?: string | null
          mood?: string | null
          notes?: string | null
          recommended_task_type?: string | null
          sleep_hours_previous?: number | null
          tasks_completed_after?: number | null
          time_of_day?: string | null
        }
        Update: {
          blockers?: string[] | null
          caffeine_intake?: number | null
          energy_level?: number
          exercise_today?: boolean | null
          focus_capacity?: string | null
          id?: number
          logged_at?: string | null
          mood?: string | null
          notes?: string | null
          recommended_task_type?: string | null
          sleep_hours_previous?: number | null
          tasks_completed_after?: number | null
          time_of_day?: string | null
        }
        Relationships: []
      }
      erc8004_data_packets: {
        Row: {
          created_at: string | null
          description: string
          encryption_envelope: string
          id: number
          packet_schema: Json
          packet_type: string
          packet_version: string | null
          sector: string
          shareable_without_decryption: boolean | null
          tier_access: number | null
          verifiable_without_decryption: boolean | null
        }
        Insert: {
          created_at?: string | null
          description: string
          encryption_envelope: string
          id?: never
          packet_schema: Json
          packet_type: string
          packet_version?: string | null
          sector: string
          shareable_without_decryption?: boolean | null
          tier_access?: number | null
          verifiable_without_decryption?: boolean | null
        }
        Update: {
          created_at?: string | null
          description?: string
          encryption_envelope?: string
          id?: never
          packet_schema?: Json
          packet_type?: string
          packet_version?: string | null
          sector?: string
          shareable_without_decryption?: boolean | null
          tier_access?: number | null
          verifiable_without_decryption?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "erc8004_data_packets_tier_access_fkey"
            columns: ["tier_access"]
            isOneToOne: false
            referencedRelation: "erc8004_data_tiers"
            referencedColumns: ["tier_number"]
          },
        ]
      }
      erc8004_data_tiers: {
        Row: {
          access_speed: string
          authentication_required: string[]
          created_at: string | null
          data_contents: string[]
          data_location: string
          encryption_method: string
          id: number
          plain_english: string
          proof_mechanism: string
          requester_min_credential: string
          sectors_applicable: string[]
          tier_code: string
          tier_name: string
          tier_number: number
        }
        Insert: {
          access_speed: string
          authentication_required: string[]
          created_at?: string | null
          data_contents: string[]
          data_location: string
          encryption_method: string
          id?: never
          plain_english: string
          proof_mechanism: string
          requester_min_credential: string
          sectors_applicable: string[]
          tier_code: string
          tier_name: string
          tier_number: number
        }
        Update: {
          access_speed?: string
          authentication_required?: string[]
          created_at?: string | null
          data_contents?: string[]
          data_location?: string
          encryption_method?: string
          id?: never
          plain_english?: string
          proof_mechanism?: string
          requester_min_credential?: string
          sectors_applicable?: string[]
          tier_code?: string
          tier_name?: string
          tier_number?: number
        }
        Relationships: []
      }
      erc8004_reputation_writes: {
        Row: {
          agent_id: string
          agent_token_id: string
          block_number: number
          chain_id: number
          contract_address: string
          created_at: string
          gas_used: number | null
          id: number
          repid_event_id: number | null
          repid_value: number
          tier: string
          tx_hash: string
        }
        Insert: {
          agent_id: string
          agent_token_id: string
          block_number: number
          chain_id?: number
          contract_address: string
          created_at?: string
          gas_used?: number | null
          id?: number
          repid_event_id?: number | null
          repid_value: number
          tier: string
          tx_hash: string
        }
        Update: {
          agent_id?: string
          agent_token_id?: string
          block_number?: number
          chain_id?: number
          contract_address?: string
          created_at?: string
          gas_used?: number | null
          id?: number
          repid_event_id?: number | null
          repid_value?: number
          tier?: string
          tx_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "erc8004_reputation_writes_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "erc8004_reputation_writes_repid_event_id_fkey"
            columns: ["repid_event_id"]
            isOneToOne: false
            referencedRelation: "repid_events"
            referencedColumns: ["id"]
          },
        ]
      }
      escalation_log: {
        Row: {
          affects_slot: string | null
          attempted_fix: string | null
          blocker: string
          created_at: string | null
          escalation_path: string
          from_agent: string
          id: string
          resolution: string | null
          resolved_at: string | null
          resolved_by: string | null
          severity: string
          status: string
          telegram_sent: boolean | null
        }
        Insert: {
          affects_slot?: string | null
          attempted_fix?: string | null
          blocker: string
          created_at?: string | null
          escalation_path?: string
          from_agent: string
          id?: string
          resolution?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          severity?: string
          status?: string
          telegram_sent?: boolean | null
        }
        Update: {
          affects_slot?: string | null
          attempted_fix?: string | null
          blocker?: string
          created_at?: string | null
          escalation_path?: string
          from_agent?: string
          id?: string
          resolution?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          severity?: string
          status?: string
          telegram_sent?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "escalation_log_affects_slot_fkey"
            columns: ["affects_slot"]
            isOneToOne: false
            referencedRelation: "priority_stack"
            referencedColumns: ["slot"]
          },
        ]
      }
      ethics_checks: {
        Row: {
          action_id: string | null
          check_type: string
          created_at: string | null
          id: string
          passed: boolean
          reason: string | null
        }
        Insert: {
          action_id?: string | null
          check_type: string
          created_at?: string | null
          id?: string
          passed: boolean
          reason?: string | null
        }
        Update: {
          action_id?: string | null
          check_type?: string
          created_at?: string | null
          id?: string
          passed?: boolean
          reason?: string | null
        }
        Relationships: []
      }
      evergreen_tasks: {
        Row: {
          assigned_to: string | null
          cooldown_minutes: number | null
          created_at: string | null
          description: string
          enabled: boolean | null
          id: string
          last_spawned_at: string | null
          priority: number | null
          spawn_threshold: number | null
          task_type: string
          title: string
        }
        Insert: {
          assigned_to?: string | null
          cooldown_minutes?: number | null
          created_at?: string | null
          description: string
          enabled?: boolean | null
          id?: string
          last_spawned_at?: string | null
          priority?: number | null
          spawn_threshold?: number | null
          task_type: string
          title: string
        }
        Update: {
          assigned_to?: string | null
          cooldown_minutes?: number | null
          created_at?: string | null
          description?: string
          enabled?: boolean | null
          id?: string
          last_spawned_at?: string | null
          priority?: number | null
          spawn_threshold?: number | null
          task_type?: string
          title?: string
        }
        Relationships: []
      }
      evolution_log: {
        Row: {
          agent: string | null
          context: Json | null
          created_at: string | null
          id: number
          metric_name: string
          value: number
        }
        Insert: {
          agent?: string | null
          context?: Json | null
          created_at?: string | null
          id?: number
          metric_name: string
          value: number
        }
        Update: {
          agent?: string | null
          context?: Json | null
          created_at?: string | null
          id?: number
          metric_name?: string
          value?: number
        }
        Relationships: []
      }
      execution_log: {
        Row: {
          agent_name: string
          cost_usd: number | null
          created_at: string | null
          error_type: string | null
          id: number
          latency_ms: number | null
          model: string | null
          provider_name: string
          savings_usd: number | null
          success: boolean | null
          task_id: number | null
          task_type: string | null
          tokens_used: number | null
          was_free_tier: boolean | null
        }
        Insert: {
          agent_name: string
          cost_usd?: number | null
          created_at?: string | null
          error_type?: string | null
          id?: number
          latency_ms?: number | null
          model?: string | null
          provider_name: string
          savings_usd?: number | null
          success?: boolean | null
          task_id?: number | null
          task_type?: string | null
          tokens_used?: number | null
          was_free_tier?: boolean | null
        }
        Update: {
          agent_name?: string
          cost_usd?: number | null
          created_at?: string | null
          error_type?: string | null
          id?: number
          latency_ms?: number | null
          model?: string | null
          provider_name?: string
          savings_usd?: number | null
          success?: boolean | null
          task_id?: number | null
          task_type?: string | null
          tokens_used?: number | null
          was_free_tier?: boolean | null
        }
        Relationships: []
      }
      execution_logs: {
        Row: {
          agent: string
          created_at: string | null
          id: number
          latency_ms: number | null
          model: string | null
          provider: string
          success: boolean | null
          task_id: number | null
          task_type: string | null
          tokens: number | null
        }
        Insert: {
          agent: string
          created_at?: string | null
          id?: number
          latency_ms?: number | null
          model?: string | null
          provider: string
          success?: boolean | null
          task_id?: number | null
          task_type?: string | null
          tokens?: number | null
        }
        Update: {
          agent?: string
          created_at?: string | null
          id?: number
          latency_ms?: number | null
          model?: string | null
          provider?: string
          success?: boolean | null
          task_id?: number | null
          task_type?: string | null
          tokens?: number | null
        }
        Relationships: []
      }
      experiment_registry: {
        Row: {
          assigned_to: string
          conclusion: string | null
          confidence_pct: number | null
          created_at: string | null
          days_running: number
          experiment_type: string
          hypothesis: string
          id: string
          metric_baseline: number | null
          metric_primary: string
          metric_result: number | null
          next_experiment_id: string | null
          results_json: Json | null
          sample_size: number
          status: string
          updated_at: string | null
        }
        Insert: {
          assigned_to?: string
          conclusion?: string | null
          confidence_pct?: number | null
          created_at?: string | null
          days_running?: number
          experiment_type: string
          hypothesis: string
          id?: string
          metric_baseline?: number | null
          metric_primary: string
          metric_result?: number | null
          next_experiment_id?: string | null
          results_json?: Json | null
          sample_size?: number
          status?: string
          updated_at?: string | null
        }
        Update: {
          assigned_to?: string
          conclusion?: string | null
          confidence_pct?: number | null
          created_at?: string | null
          days_running?: number
          experiment_type?: string
          hypothesis?: string
          id?: string
          metric_baseline?: number | null
          metric_primary?: string
          metric_result?: number | null
          next_experiment_id?: string | null
          results_json?: Json | null
          sample_size?: number
          status?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      failure_analysis: {
        Row: {
          confidence_in_fix: number | null
          created_at: string | null
          failed_agent: string | null
          failed_task_id: number | null
          failure_message: string | null
          failure_type: string
          id: number
          pattern_description: string | null
          pattern_identified: boolean | null
          prevention_strategy: string | null
          root_cause: string | null
          similar_failures_count: number | null
          spawned_prevention_task_id: number | null
        }
        Insert: {
          confidence_in_fix?: number | null
          created_at?: string | null
          failed_agent?: string | null
          failed_task_id?: number | null
          failure_message?: string | null
          failure_type: string
          id?: number
          pattern_description?: string | null
          pattern_identified?: boolean | null
          prevention_strategy?: string | null
          root_cause?: string | null
          similar_failures_count?: number | null
          spawned_prevention_task_id?: number | null
        }
        Update: {
          confidence_in_fix?: number | null
          created_at?: string | null
          failed_agent?: string | null
          failed_task_id?: number | null
          failure_message?: string | null
          failure_type?: string
          id?: number
          pattern_description?: string | null
          pattern_identified?: boolean | null
          prevention_strategy?: string | null
          root_cause?: string | null
          similar_failures_count?: number | null
          spawned_prevention_task_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "failure_analysis_failed_task_id_fkey"
            columns: ["failed_task_id"]
            isOneToOne: false
            referencedRelation: "trinity_post_task_lag"
            referencedColumns: ["task_id"]
          },
          {
            foreignKeyName: "failure_analysis_failed_task_id_fkey"
            columns: ["failed_task_id"]
            isOneToOne: false
            referencedRelation: "trinity_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "failure_analysis_spawned_prevention_task_id_fkey"
            columns: ["spawned_prevention_task_id"]
            isOneToOne: false
            referencedRelation: "trinity_post_task_lag"
            referencedColumns: ["task_id"]
          },
          {
            foreignKeyName: "failure_analysis_spawned_prevention_task_id_fkey"
            columns: ["spawned_prevention_task_id"]
            isOneToOne: false
            referencedRelation: "trinity_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      feature_registry: {
        Row: {
          blocks: string[] | null
          created_at: string | null
          depends_on: string[] | null
          description: string | null
          feature_name: string
          feature_tag: string
          hackathon_critical: boolean | null
          id: number
          notes: string | null
          owner: string | null
          sprint_target: string | null
          status: string | null
          tier: number | null
          updated_at: string | null
          v1_stub: boolean | null
        }
        Insert: {
          blocks?: string[] | null
          created_at?: string | null
          depends_on?: string[] | null
          description?: string | null
          feature_name: string
          feature_tag: string
          hackathon_critical?: boolean | null
          id?: number
          notes?: string | null
          owner?: string | null
          sprint_target?: string | null
          status?: string | null
          tier?: number | null
          updated_at?: string | null
          v1_stub?: boolean | null
        }
        Update: {
          blocks?: string[] | null
          created_at?: string | null
          depends_on?: string[] | null
          description?: string | null
          feature_name?: string
          feature_tag?: string
          hackathon_critical?: boolean | null
          id?: number
          notes?: string | null
          owner?: string | null
          sprint_target?: string | null
          status?: string | null
          tier?: number | null
          updated_at?: string | null
          v1_stub?: boolean | null
        }
        Relationships: []
      }
      feedback_events: {
        Row: {
          awarded_at: string | null
          awarded_repid_delta: number
          body: string | null
          created_at: string
          external_id: string | null
          external_url: string | null
          feedback_type: string
          id: number
          metadata: Json
          source: string
          status: string
          title: string | null
          updated_at: string
          user_handle: string | null
          user_repid_agent_id: string | null
        }
        Insert: {
          awarded_at?: string | null
          awarded_repid_delta?: number
          body?: string | null
          created_at?: string
          external_id?: string | null
          external_url?: string | null
          feedback_type: string
          id?: number
          metadata?: Json
          source: string
          status?: string
          title?: string | null
          updated_at?: string
          user_handle?: string | null
          user_repid_agent_id?: string | null
        }
        Update: {
          awarded_at?: string | null
          awarded_repid_delta?: number
          body?: string | null
          created_at?: string
          external_id?: string | null
          external_url?: string | null
          feedback_type?: string
          id?: number
          metadata?: Json
          source?: string
          status?: string
          title?: string | null
          updated_at?: string
          user_handle?: string | null
          user_repid_agent_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "feedback_events_user_repid_agent_id_fkey"
            columns: ["user_repid_agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      founder_recommendations: {
        Row: {
          agent: string
          created_at: string | null
          description: string | null
          evidence: string | null
          id: string
          potential_benefit: string | null
          priority: number | null
          recommendation_type: string | null
          repid_reward: number | null
          reviewed_at: string | null
          status: string | null
          title: string
        }
        Insert: {
          agent: string
          created_at?: string | null
          description?: string | null
          evidence?: string | null
          id?: string
          potential_benefit?: string | null
          priority?: number | null
          recommendation_type?: string | null
          repid_reward?: number | null
          reviewed_at?: string | null
          status?: string | null
          title: string
        }
        Update: {
          agent?: string
          created_at?: string | null
          description?: string | null
          evidence?: string | null
          id?: string
          potential_benefit?: string | null
          priority?: number | null
          recommendation_type?: string | null
          repid_reward?: number | null
          reviewed_at?: string | null
          status?: string | null
          title?: string
        }
        Relationships: []
      }
      free_tier_usage: {
        Row: {
          created_at: string
          id: string
          monthly_limit: number
          provider: string
          requests_used: number
          reset_date: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          monthly_limit: number
          provider: string
          requests_used?: number
          reset_date: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          monthly_limit?: number
          provider?: string
          requests_used?: number
          reset_date?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      gemini_sprint_queue: {
        Row: {
          category: string
          completed_at: string | null
          created_at: string | null
          depends_on: number[] | null
          gemini_notes: string | null
          id: number
          priority: number
          prompt: string
          started_at: string | null
          status: string
          title: string
          verify_command: string | null
          verify_target: string | null
        }
        Insert: {
          category: string
          completed_at?: string | null
          created_at?: string | null
          depends_on?: number[] | null
          gemini_notes?: string | null
          id?: number
          priority?: number
          prompt: string
          started_at?: string | null
          status?: string
          title: string
          verify_command?: string | null
          verify_target?: string | null
        }
        Update: {
          category?: string
          completed_at?: string | null
          created_at?: string | null
          depends_on?: number[] | null
          gemini_notes?: string | null
          id?: number
          priority?: number
          prompt?: string
          started_at?: string | null
          status?: string
          title?: string
          verify_command?: string | null
          verify_target?: string | null
        }
        Relationships: []
      }
      gmpd_log: {
        Row: {
          body: string
          created_at: string | null
          entry_type: string
          horizon: string | null
          id: number
          patent_ref: string | null
          source: string | null
          sprint_ref: string | null
          tags: string[] | null
          title: string
        }
        Insert: {
          body: string
          created_at?: string | null
          entry_type: string
          horizon?: string | null
          id?: number
          patent_ref?: string | null
          source?: string | null
          sprint_ref?: string | null
          tags?: string[] | null
          title: string
        }
        Update: {
          body?: string
          created_at?: string | null
          entry_type?: string
          horizon?: string | null
          id?: number
          patent_ref?: string | null
          source?: string | null
          sprint_ref?: string | null
          tags?: string[] | null
          title?: string
        }
        Relationships: []
      }
      governance_proposals: {
        Row: {
          approval_threshold: number | null
          created_at: string | null
          description: string
          executed_at: string | null
          execution_result: Json | null
          id: number
          proposal_type: string
          proposed_action: Json
          proposed_by: string
          proposer_repid: number
          quorum_requirement: number | null
          status: string | null
          title: string
          total_weight_voted: number | null
          voting_closes_at: string
          voting_method: string | null
          voting_opens_at: string | null
          weight_abstain: number | null
          weight_against: number | null
          weight_for: number | null
        }
        Insert: {
          approval_threshold?: number | null
          created_at?: string | null
          description: string
          executed_at?: string | null
          execution_result?: Json | null
          id?: number
          proposal_type: string
          proposed_action: Json
          proposed_by: string
          proposer_repid: number
          quorum_requirement?: number | null
          status?: string | null
          title: string
          total_weight_voted?: number | null
          voting_closes_at: string
          voting_method?: string | null
          voting_opens_at?: string | null
          weight_abstain?: number | null
          weight_against?: number | null
          weight_for?: number | null
        }
        Update: {
          approval_threshold?: number | null
          created_at?: string | null
          description?: string
          executed_at?: string | null
          execution_result?: Json | null
          id?: number
          proposal_type?: string
          proposed_action?: Json
          proposed_by?: string
          proposer_repid?: number
          quorum_requirement?: number | null
          status?: string | null
          title?: string
          total_weight_voted?: number | null
          voting_closes_at?: string
          voting_method?: string | null
          voting_opens_at?: string | null
          weight_abstain?: number | null
          weight_against?: number | null
          weight_for?: number | null
        }
        Relationships: []
      }
      governance_votes: {
        Row: {
          id: number
          proposal_id: number
          rationale: string | null
          vote: string
          voted_at: string | null
          voter_id: string
          voter_repid: number
          voter_type: string
          voting_weight: number
        }
        Insert: {
          id?: number
          proposal_id: number
          rationale?: string | null
          vote: string
          voted_at?: string | null
          voter_id: string
          voter_repid: number
          voter_type: string
          voting_weight: number
        }
        Update: {
          id?: number
          proposal_id?: number
          rationale?: string | null
          vote?: string
          voted_at?: string | null
          voter_id?: string
          voter_repid?: number
          voter_type?: string
          voting_weight?: number
        }
        Relationships: [
          {
            foreignKeyName: "governance_votes_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "governance_proposals"
            referencedColumns: ["id"]
          },
        ]
      }
      graph_rag_edge_inference_metrics: {
        Row: {
          agent_id: string | null
          created_at: string
          dry_run: boolean
          edge_type_distribution: Json | null
          edges_deduplicated: number
          edges_inferred: number
          edges_persisted: number
          edges_rejected_check: number
          id: number
          inference_completed_at: string | null
          inference_started_at: string
          nodes_examined: number
          notes: string | null
          run_id: string
        }
        Insert: {
          agent_id?: string | null
          created_at?: string
          dry_run?: boolean
          edge_type_distribution?: Json | null
          edges_deduplicated?: number
          edges_inferred?: number
          edges_persisted?: number
          edges_rejected_check?: number
          id?: number
          inference_completed_at?: string | null
          inference_started_at?: string
          nodes_examined?: number
          notes?: string | null
          run_id?: string
        }
        Update: {
          agent_id?: string | null
          created_at?: string
          dry_run?: boolean
          edge_type_distribution?: Json | null
          edges_deduplicated?: number
          edges_inferred?: number
          edges_persisted?: number
          edges_rejected_check?: number
          id?: number
          inference_completed_at?: string | null
          inference_started_at?: string
          nodes_examined?: number
          notes?: string | null
          run_id?: string
        }
        Relationships: []
      }
      graph_rag_retrieval_metrics: {
        Row: {
          agent_id: string | null
          created_at: string | null
          id: string
          latency_ms: number | null
          nodes_retrieved: number | null
          query: string | null
          relevance_score: number | null
        }
        Insert: {
          agent_id?: string | null
          created_at?: string | null
          id?: string
          latency_ms?: number | null
          nodes_retrieved?: number | null
          query?: string | null
          relevance_score?: number | null
        }
        Update: {
          agent_id?: string | null
          created_at?: string | null
          id?: string
          latency_ms?: number | null
          nodes_retrieved?: number | null
          query?: string | null
          relevance_score?: number | null
        }
        Relationships: []
      }
      ground_truth_facts: {
        Row: {
          category: string
          created_at: string | null
          description: string | null
          fact_key: string
          fact_value: string
          id: number
          match_type: string
          updated_at: string | null
        }
        Insert: {
          category: string
          created_at?: string | null
          description?: string | null
          fact_key: string
          fact_value: string
          id?: number
          match_type?: string
          updated_at?: string | null
        }
        Update: {
          category?: string
          created_at?: string | null
          description?: string | null
          fact_key?: string
          fact_value?: string
          id?: number
          match_type?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      hal_ablation_results: {
        Row: {
          active_layers: Json
          anfis_adjustment: number | null
          anfis_latency_ms: number | null
          anfis_triggered: boolean | null
          bft_consensus_pct: number | null
          bft_latency_ms: number | null
          bft_triggered: boolean | null
          certainty_level: number
          config_id: number
          config_name: string
          created_at: string | null
          evaluation_notes: string | null
          evaluator_blind_score: Json | null
          evaluator_id: string | null
          false_positive: boolean | null
          gnnsr_contradictions: number | null
          gnnsr_latency_ms: number | null
          gnnsr_triggered: boolean | null
          hal_compliance_score: number | null
          hal_mode: number | null
          hal_verdict: string | null
          hallucination_severity: number | null
          hallucination_type: string | null
          id: string
          is_hallucination: boolean | null
          layer_order: Json | null
          model_name: string
          model_size_category: string | null
          pcv_dissonance: number | null
          pcv_latency_ms: number | null
          pcv_triggered: boolean | null
          pcv_vetoed: boolean | null
          prompt_category: string
          prompt_id: string
          provider: string
          repid_latency_ms: number | null
          repid_triggered: boolean | null
          repid_weight: number | null
          run_id: string
          sbfa_latency_ms: number | null
          sbfa_score: number | null
          sbfa_triggered: boolean | null
          slt_latency_ms: number | null
          slt_triggered: boolean | null
          slt_uncertainty: number | null
          snapshot_id: string | null
          study_a: boolean | null
          study_b: boolean | null
          study_c: boolean | null
          temperature: number | null
          total_latency_ms: number | null
          was_caught: boolean | null
          wsce_coherence: number | null
          wsce_latency_ms: number | null
          wsce_triggered: boolean | null
        }
        Insert: {
          active_layers: Json
          anfis_adjustment?: number | null
          anfis_latency_ms?: number | null
          anfis_triggered?: boolean | null
          bft_consensus_pct?: number | null
          bft_latency_ms?: number | null
          bft_triggered?: boolean | null
          certainty_level: number
          config_id: number
          config_name: string
          created_at?: string | null
          evaluation_notes?: string | null
          evaluator_blind_score?: Json | null
          evaluator_id?: string | null
          false_positive?: boolean | null
          gnnsr_contradictions?: number | null
          gnnsr_latency_ms?: number | null
          gnnsr_triggered?: boolean | null
          hal_compliance_score?: number | null
          hal_mode?: number | null
          hal_verdict?: string | null
          hallucination_severity?: number | null
          hallucination_type?: string | null
          id?: string
          is_hallucination?: boolean | null
          layer_order?: Json | null
          model_name: string
          model_size_category?: string | null
          pcv_dissonance?: number | null
          pcv_latency_ms?: number | null
          pcv_triggered?: boolean | null
          pcv_vetoed?: boolean | null
          prompt_category: string
          prompt_id: string
          provider: string
          repid_latency_ms?: number | null
          repid_triggered?: boolean | null
          repid_weight?: number | null
          run_id: string
          sbfa_latency_ms?: number | null
          sbfa_score?: number | null
          sbfa_triggered?: boolean | null
          slt_latency_ms?: number | null
          slt_triggered?: boolean | null
          slt_uncertainty?: number | null
          snapshot_id?: string | null
          study_a?: boolean | null
          study_b?: boolean | null
          study_c?: boolean | null
          temperature?: number | null
          total_latency_ms?: number | null
          was_caught?: boolean | null
          wsce_coherence?: number | null
          wsce_latency_ms?: number | null
          wsce_triggered?: boolean | null
        }
        Update: {
          active_layers?: Json
          anfis_adjustment?: number | null
          anfis_latency_ms?: number | null
          anfis_triggered?: boolean | null
          bft_consensus_pct?: number | null
          bft_latency_ms?: number | null
          bft_triggered?: boolean | null
          certainty_level?: number
          config_id?: number
          config_name?: string
          created_at?: string | null
          evaluation_notes?: string | null
          evaluator_blind_score?: Json | null
          evaluator_id?: string | null
          false_positive?: boolean | null
          gnnsr_contradictions?: number | null
          gnnsr_latency_ms?: number | null
          gnnsr_triggered?: boolean | null
          hal_compliance_score?: number | null
          hal_mode?: number | null
          hal_verdict?: string | null
          hallucination_severity?: number | null
          hallucination_type?: string | null
          id?: string
          is_hallucination?: boolean | null
          layer_order?: Json | null
          model_name?: string
          model_size_category?: string | null
          pcv_dissonance?: number | null
          pcv_latency_ms?: number | null
          pcv_triggered?: boolean | null
          pcv_vetoed?: boolean | null
          prompt_category?: string
          prompt_id?: string
          provider?: string
          repid_latency_ms?: number | null
          repid_triggered?: boolean | null
          repid_weight?: number | null
          run_id?: string
          sbfa_latency_ms?: number | null
          sbfa_score?: number | null
          sbfa_triggered?: boolean | null
          slt_latency_ms?: number | null
          slt_triggered?: boolean | null
          slt_uncertainty?: number | null
          snapshot_id?: string | null
          study_a?: boolean | null
          study_b?: boolean | null
          study_c?: boolean | null
          temperature?: number | null
          total_latency_ms?: number | null
          was_caught?: boolean | null
          wsce_coherence?: number | null
          wsce_latency_ms?: number | null
          wsce_triggered?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "hal_ablation_results_prompt_id_fkey"
            columns: ["prompt_id"]
            isOneToOne: false
            referencedRelation: "hal_test_prompts"
            referencedColumns: ["prompt_id"]
          },
          {
            foreignKeyName: "hal_ablation_results_snapshot_id_fkey"
            columns: ["snapshot_id"]
            isOneToOne: false
            referencedRelation: "hal_anfis_snapshots"
            referencedColumns: ["snapshot_id"]
          },
        ]
      }
      hal_anfis_snapshots: {
        Row: {
          ablation_battery_results_id: string | null
          ablation_battery_run: boolean | null
          anfis_membership_functions: Json | null
          anfis_rule_weights: Json | null
          anfis_weights: Json
          antifragility_delta: number | null
          created_at: string | null
          domains_active: Json | null
          frozen_catch_rate: number | null
          hallucination_types_encountered: Json | null
          hashkey_block_number: number | null
          hashkey_tx_hash: string | null
          id: string
          is_milestone: boolean | null
          is_pre_registration: boolean | null
          live_catch_rate: number | null
          merkle_root: string | null
          milestone_description: string | null
          network_agents_active: number | null
          production_events_since_last: number | null
          snapshot_hash: string
          snapshot_id: string
          snapshot_version: number
          wsce_parameters: Json | null
        }
        Insert: {
          ablation_battery_results_id?: string | null
          ablation_battery_run?: boolean | null
          anfis_membership_functions?: Json | null
          anfis_rule_weights?: Json | null
          anfis_weights: Json
          antifragility_delta?: number | null
          created_at?: string | null
          domains_active?: Json | null
          frozen_catch_rate?: number | null
          hallucination_types_encountered?: Json | null
          hashkey_block_number?: number | null
          hashkey_tx_hash?: string | null
          id?: string
          is_milestone?: boolean | null
          is_pre_registration?: boolean | null
          live_catch_rate?: number | null
          merkle_root?: string | null
          milestone_description?: string | null
          network_agents_active?: number | null
          production_events_since_last?: number | null
          snapshot_hash: string
          snapshot_id: string
          snapshot_version?: number
          wsce_parameters?: Json | null
        }
        Update: {
          ablation_battery_results_id?: string | null
          ablation_battery_run?: boolean | null
          anfis_membership_functions?: Json | null
          anfis_rule_weights?: Json | null
          anfis_weights?: Json
          antifragility_delta?: number | null
          created_at?: string | null
          domains_active?: Json | null
          frozen_catch_rate?: number | null
          hallucination_types_encountered?: Json | null
          hashkey_block_number?: number | null
          hashkey_tx_hash?: string | null
          id?: string
          is_milestone?: boolean | null
          is_pre_registration?: boolean | null
          live_catch_rate?: number | null
          merkle_root?: string | null
          milestone_description?: string | null
          network_agents_active?: number | null
          production_events_since_last?: number | null
          snapshot_hash?: string
          snapshot_id?: string
          snapshot_version?: number
          wsce_parameters?: Json | null
        }
        Relationships: []
      }
      hal_antifragility_metrics: {
        Row: {
          adaptation_speed_batches: number | null
          adaptation_speed_target_met: boolean | null
          compared_to_snapshot_id: string
          created_at: string | null
          days_between: number | null
          domain_metrics: Json | null
          early_exit_efficiency_gain_pct: number | null
          early_exit_target_met: boolean | null
          false_positive_reduction_pct: number | null
          false_positive_target_met: boolean | null
          hallucination_rate_delta: number | null
          hallucination_rate_target_met: boolean | null
          id: string
          is_antifragile: boolean | null
          metrics_at_target: number | null
          new_type_robustness_pct: number | null
          new_type_target_met: boolean | null
          shap_interaction_matrix: Json | null
          shap_main_effects: Json | null
          snapshot_id: string
          synergistic_pairs: Json | null
          wsce_target_met: boolean | null
          wsce_variance_decrease_pct: number | null
        }
        Insert: {
          adaptation_speed_batches?: number | null
          adaptation_speed_target_met?: boolean | null
          compared_to_snapshot_id: string
          created_at?: string | null
          days_between?: number | null
          domain_metrics?: Json | null
          early_exit_efficiency_gain_pct?: number | null
          early_exit_target_met?: boolean | null
          false_positive_reduction_pct?: number | null
          false_positive_target_met?: boolean | null
          hallucination_rate_delta?: number | null
          hallucination_rate_target_met?: boolean | null
          id?: string
          is_antifragile?: boolean | null
          metrics_at_target?: number | null
          new_type_robustness_pct?: number | null
          new_type_target_met?: boolean | null
          shap_interaction_matrix?: Json | null
          shap_main_effects?: Json | null
          snapshot_id: string
          synergistic_pairs?: Json | null
          wsce_target_met?: boolean | null
          wsce_variance_decrease_pct?: number | null
        }
        Update: {
          adaptation_speed_batches?: number | null
          adaptation_speed_target_met?: boolean | null
          compared_to_snapshot_id?: string
          created_at?: string | null
          days_between?: number | null
          domain_metrics?: Json | null
          early_exit_efficiency_gain_pct?: number | null
          early_exit_target_met?: boolean | null
          false_positive_reduction_pct?: number | null
          false_positive_target_met?: boolean | null
          hallucination_rate_delta?: number | null
          hallucination_rate_target_met?: boolean | null
          id?: string
          is_antifragile?: boolean | null
          metrics_at_target?: number | null
          new_type_robustness_pct?: number | null
          new_type_target_met?: boolean | null
          shap_interaction_matrix?: Json | null
          shap_main_effects?: Json | null
          snapshot_id?: string
          synergistic_pairs?: Json | null
          wsce_target_met?: boolean | null
          wsce_variance_decrease_pct?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "hal_antifragility_metrics_snapshot_id_fkey"
            columns: ["snapshot_id"]
            isOneToOne: false
            referencedRelation: "hal_anfis_snapshots"
            referencedColumns: ["snapshot_id"]
          },
        ]
      }
      hal_audit_chain: {
        Row: {
          created_at: string | null
          current_entry_hash: string
          event_payload: Json
          id: number
          previous_entry_hash: string | null
          source_id: string
          source_table: string
        }
        Insert: {
          created_at?: string | null
          current_entry_hash: string
          event_payload: Json
          id?: number
          previous_entry_hash?: string | null
          source_id: string
          source_table: string
        }
        Update: {
          created_at?: string | null
          current_entry_hash?: string
          event_payload?: Json
          id?: number
          previous_entry_hash?: string | null
          source_id?: string
          source_table?: string
        }
        Relationships: []
      }
      hal_benchmark_results: {
        Row: {
          created_at: string | null
          failure_type: string | null
          hal_would_catch: boolean | null
          id: number
          model: string
          notes: string | null
          passed: boolean
          provider: string
          question: string | null
          response: string | null
          test_type: string
          tester: string | null
        }
        Insert: {
          created_at?: string | null
          failure_type?: string | null
          hal_would_catch?: boolean | null
          id?: number
          model: string
          notes?: string | null
          passed: boolean
          provider: string
          question?: string | null
          response?: string | null
          test_type: string
          tester?: string | null
        }
        Update: {
          created_at?: string | null
          failure_type?: string | null
          hal_would_catch?: boolean | null
          id?: number
          model?: string
          notes?: string | null
          passed?: boolean
          provider?: string
          question?: string | null
          response?: string | null
          test_type?: string
          tester?: string | null
        }
        Relationships: []
      }
      hal_classifications: {
        Row: {
          category: string
          confidence: string
          created_at: string
          id: number
          latency_ms: number
          model: string | null
          prompt_hash: string
          provider: string | null
        }
        Insert: {
          category: string
          confidence: string
          created_at?: string
          id?: number
          latency_ms: number
          model?: string | null
          prompt_hash: string
          provider?: string | null
        }
        Update: {
          category?: string
          confidence?: string
          created_at?: string
          id?: number
          latency_ms?: number
          model?: string | null
          prompt_hash?: string
          provider?: string | null
        }
        Relationships: []
      }
      hal_evaluations: {
        Row: {
          agent_id: string | null
          api_key_hash: string | null
          certainty_used: number | null
          comma_gap: number | null
          corpus_version: string | null
          cost_usd: number | null
          decision: string | null
          experiment_id: string | null
          false_positive: boolean | null
          gen_latency_ms: number | null
          gen_model: string | null
          gen_provider: string | null
          ground_truth_label: string | null
          hal_mode: string | null
          hal_score: number | null
          hal_signals: Json | null
          hal_vetoed: boolean | null
          hyperdag_bench_commit: string | null
          id: string
          manifest_dataset_id: string | null
          mode: string
          notes: string | null
          parent_evaluation_id: string | null
          prompt_id: string | null
          prompt_source: string | null
          prompt_text_hash: string | null
          repid_delta: number | null
          repid_engine_commit: string | null
          threshold_set_version: string | null
          ts: string
          veto_class: string | null
          was_caught: boolean | null
        }
        Insert: {
          agent_id?: string | null
          api_key_hash?: string | null
          certainty_used?: number | null
          comma_gap?: number | null
          corpus_version?: string | null
          cost_usd?: number | null
          decision?: string | null
          experiment_id?: string | null
          false_positive?: boolean | null
          gen_latency_ms?: number | null
          gen_model?: string | null
          gen_provider?: string | null
          ground_truth_label?: string | null
          hal_mode?: string | null
          hal_score?: number | null
          hal_signals?: Json | null
          hal_vetoed?: boolean | null
          hyperdag_bench_commit?: string | null
          id?: string
          manifest_dataset_id?: string | null
          mode: string
          notes?: string | null
          parent_evaluation_id?: string | null
          prompt_id?: string | null
          prompt_source?: string | null
          prompt_text_hash?: string | null
          repid_delta?: number | null
          repid_engine_commit?: string | null
          threshold_set_version?: string | null
          ts?: string
          veto_class?: string | null
          was_caught?: boolean | null
        }
        Update: {
          agent_id?: string | null
          api_key_hash?: string | null
          certainty_used?: number | null
          comma_gap?: number | null
          corpus_version?: string | null
          cost_usd?: number | null
          decision?: string | null
          experiment_id?: string | null
          false_positive?: boolean | null
          gen_latency_ms?: number | null
          gen_model?: string | null
          gen_provider?: string | null
          ground_truth_label?: string | null
          hal_mode?: string | null
          hal_score?: number | null
          hal_signals?: Json | null
          hal_vetoed?: boolean | null
          hyperdag_bench_commit?: string | null
          id?: string
          manifest_dataset_id?: string | null
          mode?: string
          notes?: string | null
          parent_evaluation_id?: string | null
          prompt_id?: string | null
          prompt_source?: string | null
          prompt_text_hash?: string | null
          repid_delta?: number | null
          repid_engine_commit?: string | null
          threshold_set_version?: string | null
          ts?: string
          veto_class?: string | null
          was_caught?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "hal_evaluations_parent_evaluation_id_fkey"
            columns: ["parent_evaluation_id"]
            isOneToOne: false
            referencedRelation: "hal_evaluations"
            referencedColumns: ["id"]
          },
        ]
      }
      hal_evergreen_tasks: {
        Row: {
          children_spawned: number | null
          claimed_at: string | null
          claimed_by: string | null
          completed_at: string | null
          contributes_to_ablation: boolean | null
          contributes_to_snapshot: boolean | null
          created_at: string | null
          description: string
          domain: string | null
          id: string
          input_params: Json | null
          last_run_at: string | null
          parent_task_id: string | null
          preferred_agent: string | null
          priority: number | null
          repeat_interval_hours: number | null
          repid_reward: number | null
          result: Json | null
          result_quality_score: number | null
          run_count: number | null
          spawn_template: Json | null
          spawns_children: boolean | null
          started_at: string | null
          status: string
          task_category: string
          task_type: string
          title: string
        }
        Insert: {
          children_spawned?: number | null
          claimed_at?: string | null
          claimed_by?: string | null
          completed_at?: string | null
          contributes_to_ablation?: boolean | null
          contributes_to_snapshot?: boolean | null
          created_at?: string | null
          description: string
          domain?: string | null
          id?: string
          input_params?: Json | null
          last_run_at?: string | null
          parent_task_id?: string | null
          preferred_agent?: string | null
          priority?: number | null
          repeat_interval_hours?: number | null
          repid_reward?: number | null
          result?: Json | null
          result_quality_score?: number | null
          run_count?: number | null
          spawn_template?: Json | null
          spawns_children?: boolean | null
          started_at?: string | null
          status?: string
          task_category: string
          task_type: string
          title: string
        }
        Update: {
          children_spawned?: number | null
          claimed_at?: string | null
          claimed_by?: string | null
          completed_at?: string | null
          contributes_to_ablation?: boolean | null
          contributes_to_snapshot?: boolean | null
          created_at?: string | null
          description?: string
          domain?: string | null
          id?: string
          input_params?: Json | null
          last_run_at?: string | null
          parent_task_id?: string | null
          preferred_agent?: string | null
          priority?: number | null
          repeat_interval_hours?: number | null
          repid_reward?: number | null
          result?: Json | null
          result_quality_score?: number | null
          run_count?: number | null
          spawn_template?: Json | null
          spawns_children?: boolean | null
          started_at?: string | null
          status?: string
          task_category?: string
          task_type?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "hal_evergreen_tasks_parent_task_id_fkey"
            columns: ["parent_task_id"]
            isOneToOne: false
            referencedRelation: "hal_evergreen_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      hal_federation_cycles: {
        Row: {
          agents_contributed: number | null
          anfis_weight_delta_magnitude: number | null
          catch_rate_improvement: number | null
          created_at: string | null
          cycle_id: string
          cycle_type: string
          deltas_accepted: number | null
          deltas_received: number | null
          deltas_rejected: number | null
          domains_updated: Json | null
          hallucination_rate_after: number | null
          hallucination_rate_before: number | null
          hashkey_tx_hash: string | null
          id: string
          merkle_root: string | null
          rejection_reasons: Json | null
          snapshot_id: string | null
          triggered_by_outbreak_id: string | null
        }
        Insert: {
          agents_contributed?: number | null
          anfis_weight_delta_magnitude?: number | null
          catch_rate_improvement?: number | null
          created_at?: string | null
          cycle_id: string
          cycle_type: string
          deltas_accepted?: number | null
          deltas_received?: number | null
          deltas_rejected?: number | null
          domains_updated?: Json | null
          hallucination_rate_after?: number | null
          hallucination_rate_before?: number | null
          hashkey_tx_hash?: string | null
          id?: string
          merkle_root?: string | null
          rejection_reasons?: Json | null
          snapshot_id?: string | null
          triggered_by_outbreak_id?: string | null
        }
        Update: {
          agents_contributed?: number | null
          anfis_weight_delta_magnitude?: number | null
          catch_rate_improvement?: number | null
          created_at?: string | null
          cycle_id?: string
          cycle_type?: string
          deltas_accepted?: number | null
          deltas_received?: number | null
          deltas_rejected?: number | null
          domains_updated?: Json | null
          hallucination_rate_after?: number | null
          hallucination_rate_before?: number | null
          hashkey_tx_hash?: string | null
          id?: string
          merkle_root?: string | null
          rejection_reasons?: Json | null
          snapshot_id?: string | null
          triggered_by_outbreak_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "hal_federation_cycles_snapshot_id_fkey"
            columns: ["snapshot_id"]
            isOneToOne: false
            referencedRelation: "hal_anfis_snapshots"
            referencedColumns: ["snapshot_id"]
          },
        ]
      }
      hal_ground_truth_labels: {
        Row: {
          created_at: string
          ground_truth_confidence: number
          id: number
          is_hallucination: boolean
          labeled_by: string
          rationale: string | null
          source_id: string
          source_table: string
        }
        Insert: {
          created_at?: string
          ground_truth_confidence: number
          id?: number
          is_hallucination: boolean
          labeled_by: string
          rationale?: string | null
          source_id: string
          source_table: string
        }
        Update: {
          created_at?: string
          ground_truth_confidence?: number
          id?: number
          is_hallucination?: boolean
          labeled_by?: string
          rationale?: string | null
          source_id?: string
          source_table?: string
        }
        Relationships: []
      }
      hal_network_health: {
        Row: {
          active_agents_24h: number | null
          active_outbreaks: number | null
          avg_hal_latency_ms: number | null
          catch_rate_by_domain: Json | null
          catch_rate_by_hallucination_type: Json | null
          contributing_agents_24h: number | null
          domain_pools: Json | null
          hours_since_last_federation: number | null
          id: string
          improvement_rate_7d: number | null
          is_improving: boolean | null
          last_federation_cycle_id: string | null
          outbreaks_last_30_days: number | null
          overall_catch_rate: number | null
          p95_hal_latency_ms: number | null
          pending_deltas: number | null
          recorded_at: string | null
          total_agents: number | null
        }
        Insert: {
          active_agents_24h?: number | null
          active_outbreaks?: number | null
          avg_hal_latency_ms?: number | null
          catch_rate_by_domain?: Json | null
          catch_rate_by_hallucination_type?: Json | null
          contributing_agents_24h?: number | null
          domain_pools?: Json | null
          hours_since_last_federation?: number | null
          id?: string
          improvement_rate_7d?: number | null
          is_improving?: boolean | null
          last_federation_cycle_id?: string | null
          outbreaks_last_30_days?: number | null
          overall_catch_rate?: number | null
          p95_hal_latency_ms?: number | null
          pending_deltas?: number | null
          recorded_at?: string | null
          total_agents?: number | null
        }
        Update: {
          active_agents_24h?: number | null
          active_outbreaks?: number | null
          avg_hal_latency_ms?: number | null
          catch_rate_by_domain?: Json | null
          catch_rate_by_hallucination_type?: Json | null
          contributing_agents_24h?: number | null
          domain_pools?: Json | null
          hours_since_last_federation?: number | null
          id?: string
          improvement_rate_7d?: number | null
          is_improving?: boolean | null
          last_federation_cycle_id?: string | null
          outbreaks_last_30_days?: number | null
          overall_catch_rate?: number | null
          p95_hal_latency_ms?: number | null
          pending_deltas?: number | null
          recorded_at?: string | null
          total_agents?: number | null
        }
        Relationships: []
      }
      hal_outbreak_events: {
        Row: {
          agents_exposed: number | null
          agents_inoculated: number | null
          catch_rate_after: number | null
          catch_rate_before: number | null
          created_at: string | null
          detected_at: string
          domain: string
          emergency_federation_triggered: boolean | null
          federation_cycle_id: string | null
          hallucination_type: string
          hallucinations_prevented_estimate: number | null
          hashkey_tx_hash: string | null
          id: string
          inoculated_at: string | null
          outbreak_id: string
          time_to_detect_minutes: number | null
          time_to_inoculate_minutes: number | null
          trigger_agent_count: number
          trigger_threshold_used: number
        }
        Insert: {
          agents_exposed?: number | null
          agents_inoculated?: number | null
          catch_rate_after?: number | null
          catch_rate_before?: number | null
          created_at?: string | null
          detected_at?: string
          domain: string
          emergency_federation_triggered?: boolean | null
          federation_cycle_id?: string | null
          hallucination_type: string
          hallucinations_prevented_estimate?: number | null
          hashkey_tx_hash?: string | null
          id?: string
          inoculated_at?: string | null
          outbreak_id: string
          time_to_detect_minutes?: number | null
          time_to_inoculate_minutes?: number | null
          trigger_agent_count: number
          trigger_threshold_used?: number
        }
        Update: {
          agents_exposed?: number | null
          agents_inoculated?: number | null
          catch_rate_after?: number | null
          catch_rate_before?: number | null
          created_at?: string | null
          detected_at?: string
          domain?: string
          emergency_federation_triggered?: boolean | null
          federation_cycle_id?: string | null
          hallucination_type?: string
          hallucinations_prevented_estimate?: number | null
          hashkey_tx_hash?: string | null
          id?: string
          inoculated_at?: string | null
          outbreak_id?: string
          time_to_detect_minutes?: number | null
          time_to_inoculate_minutes?: number | null
          trigger_agent_count?: number
          trigger_threshold_used?: number
        }
        Relationships: []
      }
      hal_production_events: {
        Row: {
          agent_domain: string
          agent_id: string | null
          agent_repid: number | null
          anfis_adjustment: number | null
          anfis_delta_generated: boolean | null
          anfis_delta_magnitude: number | null
          anfis_latency_ms: number | null
          bft_consensus_pct: number | null
          bft_latency_ms: number | null
          certainty_at_claim: number | null
          contributed_to_outbreak: boolean | null
          created_at: string | null
          eas_attestation_id: string | null
          false_positive: boolean | null
          federation_batch_id: string | null
          gnnsr_contradictions: number | null
          gnnsr_latency_ms: number | null
          hal_compliance_score: number | null
          hal_mode: number
          hal_verdict: string
          hallucination_severity: number | null
          hallucination_type: string | null
          hashkey_tx_hash: string | null
          id: string
          is_hallucination: boolean | null
          layer_first_flagged: string | null
          layers_active: Json
          pcv_dissonance: number | null
          pcv_latency_ms: number | null
          pcv_vetoed: boolean | null
          prompt_hash: string
          repid_latency_ms: number | null
          repid_weight: number | null
          sbfa_latency_ms: number | null
          sbfa_score: number | null
          slt_latency_ms: number | null
          slt_uncertainty: number | null
          total_latency_ms: number | null
          vldp_epsilon: number | null
          was_caught: boolean | null
          wsce_coherence: number | null
          wsce_latency_ms: number | null
          zkp_proof_hash: string | null
        }
        Insert: {
          agent_domain?: string
          agent_id?: string | null
          agent_repid?: number | null
          anfis_adjustment?: number | null
          anfis_delta_generated?: boolean | null
          anfis_delta_magnitude?: number | null
          anfis_latency_ms?: number | null
          bft_consensus_pct?: number | null
          bft_latency_ms?: number | null
          certainty_at_claim?: number | null
          contributed_to_outbreak?: boolean | null
          created_at?: string | null
          eas_attestation_id?: string | null
          false_positive?: boolean | null
          federation_batch_id?: string | null
          gnnsr_contradictions?: number | null
          gnnsr_latency_ms?: number | null
          hal_compliance_score?: number | null
          hal_mode: number
          hal_verdict: string
          hallucination_severity?: number | null
          hallucination_type?: string | null
          hashkey_tx_hash?: string | null
          id?: string
          is_hallucination?: boolean | null
          layer_first_flagged?: string | null
          layers_active?: Json
          pcv_dissonance?: number | null
          pcv_latency_ms?: number | null
          pcv_vetoed?: boolean | null
          prompt_hash: string
          repid_latency_ms?: number | null
          repid_weight?: number | null
          sbfa_latency_ms?: number | null
          sbfa_score?: number | null
          slt_latency_ms?: number | null
          slt_uncertainty?: number | null
          total_latency_ms?: number | null
          vldp_epsilon?: number | null
          was_caught?: boolean | null
          wsce_coherence?: number | null
          wsce_latency_ms?: number | null
          zkp_proof_hash?: string | null
        }
        Update: {
          agent_domain?: string
          agent_id?: string | null
          agent_repid?: number | null
          anfis_adjustment?: number | null
          anfis_delta_generated?: boolean | null
          anfis_delta_magnitude?: number | null
          anfis_latency_ms?: number | null
          bft_consensus_pct?: number | null
          bft_latency_ms?: number | null
          certainty_at_claim?: number | null
          contributed_to_outbreak?: boolean | null
          created_at?: string | null
          eas_attestation_id?: string | null
          false_positive?: boolean | null
          federation_batch_id?: string | null
          gnnsr_contradictions?: number | null
          gnnsr_latency_ms?: number | null
          hal_compliance_score?: number | null
          hal_mode?: number
          hal_verdict?: string
          hallucination_severity?: number | null
          hallucination_type?: string | null
          hashkey_tx_hash?: string | null
          id?: string
          is_hallucination?: boolean | null
          layer_first_flagged?: string | null
          layers_active?: Json
          pcv_dissonance?: number | null
          pcv_latency_ms?: number | null
          pcv_vetoed?: boolean | null
          prompt_hash?: string
          repid_latency_ms?: number | null
          repid_weight?: number | null
          sbfa_latency_ms?: number | null
          sbfa_score?: number | null
          slt_latency_ms?: number | null
          slt_uncertainty?: number | null
          total_latency_ms?: number | null
          vldp_epsilon?: number | null
          was_caught?: boolean | null
          wsce_coherence?: number | null
          wsce_latency_ms?: number | null
          zkp_proof_hash?: string | null
        }
        Relationships: []
      }
      hal_runner_results: {
        Row: {
          benchmark_source: string
          comma_gap: number | null
          created_at: string
          estimated_cost_usd: number | null
          false_positive: boolean | null
          gen_failed: boolean
          gen_failure_reason: string | null
          gen_latency_ms: number | null
          gen_model: string | null
          gen_provider: string | null
          generated_answer: string | null
          ground_truth_is_hallucination: boolean | null
          hal_diagnostics: Json | null
          hal_latency_ms: number | null
          hal_mode: string | null
          hal_providers_used: string[] | null
          hal_score: number | null
          hal_threshold: number | null
          hal_vetoed: boolean | null
          hyperdag_bench_commit: string | null
          id: string
          manifest_dataset_id: string | null
          prompt_id: string
          providers_attempted: string[] | null
          repid_engine_commit: string | null
          run_id: string
          signals: Json | null
          veto_class: string | null
          was_caught: boolean | null
        }
        Insert: {
          benchmark_source: string
          comma_gap?: number | null
          created_at?: string
          estimated_cost_usd?: number | null
          false_positive?: boolean | null
          gen_failed?: boolean
          gen_failure_reason?: string | null
          gen_latency_ms?: number | null
          gen_model?: string | null
          gen_provider?: string | null
          generated_answer?: string | null
          ground_truth_is_hallucination?: boolean | null
          hal_diagnostics?: Json | null
          hal_latency_ms?: number | null
          hal_mode?: string | null
          hal_providers_used?: string[] | null
          hal_score?: number | null
          hal_threshold?: number | null
          hal_vetoed?: boolean | null
          hyperdag_bench_commit?: string | null
          id?: string
          manifest_dataset_id?: string | null
          prompt_id: string
          providers_attempted?: string[] | null
          repid_engine_commit?: string | null
          run_id: string
          signals?: Json | null
          veto_class?: string | null
          was_caught?: boolean | null
        }
        Update: {
          benchmark_source?: string
          comma_gap?: number | null
          created_at?: string
          estimated_cost_usd?: number | null
          false_positive?: boolean | null
          gen_failed?: boolean
          gen_failure_reason?: string | null
          gen_latency_ms?: number | null
          gen_model?: string | null
          gen_provider?: string | null
          generated_answer?: string | null
          ground_truth_is_hallucination?: boolean | null
          hal_diagnostics?: Json | null
          hal_latency_ms?: number | null
          hal_mode?: string | null
          hal_providers_used?: string[] | null
          hal_score?: number | null
          hal_threshold?: number | null
          hal_vetoed?: boolean | null
          hyperdag_bench_commit?: string | null
          id?: string
          manifest_dataset_id?: string | null
          prompt_id?: string
          providers_attempted?: string[] | null
          repid_engine_commit?: string | null
          run_id?: string
          signals?: Json | null
          veto_class?: string | null
          was_caught?: boolean | null
        }
        Relationships: []
      }
      hal_signals: {
        Row: {
          action: string
          confidence: number
          created_at: string | null
          dissonance: number
          id: number
          notified_count: number | null
          pair: string
          price_usd: number | null
          reason: string | null
        }
        Insert: {
          action: string
          confidence: number
          created_at?: string | null
          dissonance: number
          id?: number
          notified_count?: number | null
          pair: string
          price_usd?: number | null
          reason?: string | null
        }
        Update: {
          action?: string
          confidence?: number
          created_at?: string | null
          dissonance?: number
          id?: number
          notified_count?: number | null
          pair?: string
          price_usd?: number | null
          reason?: string | null
        }
        Relationships: []
      }
      hal_snapshot_registry: {
        Row: {
          ablation_report: string | null
          ablation_tested: boolean | null
          avg_latency_ms: number | null
          created_at: string | null
          false_positive_rate: number | null
          frozen_at: string | null
          frozen_by: string | null
          hallucinations_caught: number
          id: number
          snapshot_hash: string
          status: string | null
          test_cases_count: number
          version: string
          zkp_attestation_uid: string | null
          zkp_attested_at: string | null
        }
        Insert: {
          ablation_report?: string | null
          ablation_tested?: boolean | null
          avg_latency_ms?: number | null
          created_at?: string | null
          false_positive_rate?: number | null
          frozen_at?: string | null
          frozen_by?: string | null
          hallucinations_caught: number
          id?: number
          snapshot_hash: string
          status?: string | null
          test_cases_count: number
          version: string
          zkp_attestation_uid?: string | null
          zkp_attested_at?: string | null
        }
        Update: {
          ablation_report?: string | null
          ablation_tested?: boolean | null
          avg_latency_ms?: number | null
          created_at?: string | null
          false_positive_rate?: number | null
          frozen_at?: string | null
          frozen_by?: string | null
          hallucinations_caught?: number
          id?: number
          snapshot_hash?: string
          status?: string | null
          test_cases_count?: number
          version?: string
          zkp_attestation_uid?: string | null
          zkp_attested_at?: string | null
        }
        Relationships: []
      }
      hal_test_prompts: {
        Row: {
          benchmark_source: string
          category: string
          certainty_levels_to_test: Json | null
          created_at: string | null
          domain: string
          expected_hallucination_type: string
          ground_truth: string
          human_verified: boolean | null
          id: string
          needs_human_review: boolean | null
          notes: string | null
          pilot_prompt: boolean | null
          prompt_id: string
          prompt_text: string
          times_hallucination_caught: number | null
          times_used: number | null
          verified_at: string | null
          verified_by: string | null
        }
        Insert: {
          benchmark_source: string
          category: string
          certainty_levels_to_test?: Json | null
          created_at?: string | null
          domain?: string
          expected_hallucination_type: string
          ground_truth: string
          human_verified?: boolean | null
          id?: string
          needs_human_review?: boolean | null
          notes?: string | null
          pilot_prompt?: boolean | null
          prompt_id: string
          prompt_text: string
          times_hallucination_caught?: number | null
          times_used?: number | null
          verified_at?: string | null
          verified_by?: string | null
        }
        Update: {
          benchmark_source?: string
          category?: string
          certainty_levels_to_test?: Json | null
          created_at?: string | null
          domain?: string
          expected_hallucination_type?: string
          ground_truth?: string
          human_verified?: boolean | null
          id?: string
          needs_human_review?: boolean | null
          notes?: string | null
          pilot_prompt?: boolean | null
          prompt_id?: string
          prompt_text?: string
          times_hallucination_caught?: number | null
          times_used?: number | null
          verified_at?: string | null
          verified_by?: string | null
        }
        Relationships: []
      }
      hal_threshold_sweeps: {
        Row: {
          benchmark_source: string | null
          comma_gap: number | null
          created_at: string
          false_positive: boolean | null
          gen_model: string
          gen_provider: string
          hal_score: number | null
          hal_vetoed: boolean
          id: string
          is_hallucination: boolean | null
          latency_ms: number | null
          prompt_id: string
          run_id: string
          signals: Json | null
          threshold_value: number
          was_caught: boolean | null
        }
        Insert: {
          benchmark_source?: string | null
          comma_gap?: number | null
          created_at?: string
          false_positive?: boolean | null
          gen_model: string
          gen_provider: string
          hal_score?: number | null
          hal_vetoed: boolean
          id?: string
          is_hallucination?: boolean | null
          latency_ms?: number | null
          prompt_id: string
          run_id: string
          signals?: Json | null
          threshold_value: number
          was_caught?: boolean | null
        }
        Update: {
          benchmark_source?: string | null
          comma_gap?: number | null
          created_at?: string
          false_positive?: boolean | null
          gen_model?: string
          gen_provider?: string
          hal_score?: number | null
          hal_vetoed?: boolean
          id?: string
          is_hallucination?: boolean | null
          latency_ms?: number | null
          prompt_id?: string
          run_id?: string
          signals?: Json | null
          threshold_value?: number
          was_caught?: boolean | null
        }
        Relationships: []
      }
      hal_threshold_updates: {
        Row: {
          created_at: string | null
          effective_at: string | null
          hal_layer: number
          id: number
          new_value: number
          old_value: number
          snapshot_id: number | null
          threshold_key: string
          trigger_catch_rate: number | null
          trigger_event_count: number | null
          update_type: string | null
        }
        Insert: {
          created_at?: string | null
          effective_at?: string | null
          hal_layer: number
          id?: number
          new_value: number
          old_value: number
          snapshot_id?: number | null
          threshold_key: string
          trigger_catch_rate?: number | null
          trigger_event_count?: number | null
          update_type?: string | null
        }
        Update: {
          created_at?: string | null
          effective_at?: string | null
          hal_layer?: number
          id?: number
          new_value?: number
          old_value?: number
          snapshot_id?: number | null
          threshold_key?: string
          trigger_catch_rate?: number | null
          trigger_event_count?: number | null
          update_type?: string | null
        }
        Relationships: []
      }
      hal_training_cases: {
        Row: {
          added_to_test_suite: boolean | null
          agent_id: string | null
          catch_confirmed_by: string[] | null
          catch_method: string | null
          created_at: string | null
          dissonance_score: number
          hal_layer_triggered: number | null
          hallucination_type: string | null
          id: number
          llm_model: string | null
          llm_provider: string
          original_claim: string
          source_event_id: number | null
        }
        Insert: {
          added_to_test_suite?: boolean | null
          agent_id?: string | null
          catch_confirmed_by?: string[] | null
          catch_method?: string | null
          created_at?: string | null
          dissonance_score: number
          hal_layer_triggered?: number | null
          hallucination_type?: string | null
          id?: number
          llm_model?: string | null
          llm_provider: string
          original_claim: string
          source_event_id?: number | null
        }
        Update: {
          added_to_test_suite?: boolean | null
          agent_id?: string | null
          catch_confirmed_by?: string[] | null
          catch_method?: string | null
          created_at?: string | null
          dissonance_score?: number
          hal_layer_triggered?: number | null
          hallucination_type?: string | null
          id?: number
          llm_model?: string | null
          llm_provider?: string
          original_claim?: string
          source_event_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "hal_training_cases_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hal_training_cases_source_event_id_fkey"
            columns: ["source_event_id"]
            isOneToOne: false
            referencedRelation: "repid_score_events"
            referencedColumns: ["id"]
          },
        ]
      }
      hal_veto_test_results: {
        Row: {
          actual_decision: string
          created_at: string | null
          dissonance_score: number | null
          expected_decision: string
          id: number
          notes: string | null
          passed: boolean
          signal_set: Json
          test_name: string
          tester: string | null
        }
        Insert: {
          actual_decision: string
          created_at?: string | null
          dissonance_score?: number | null
          expected_decision: string
          id?: number
          notes?: string | null
          passed: boolean
          signal_set: Json
          test_name: string
          tester?: string | null
        }
        Update: {
          actual_decision?: string
          created_at?: string | null
          dissonance_score?: number | null
          expected_decision?: string
          id?: number
          notes?: string | null
          passed?: boolean
          signal_set?: Json
          test_name?: string
          tester?: string | null
        }
        Relationships: []
      }
      hallucination_test_log: {
        Row: {
          actual_outcome: string | null
          expected_outcome: string | null
          id: number
          input_data: Json | null
          notes: string | null
          passed: boolean | null
          test_type: string
          tested_at: string | null
        }
        Insert: {
          actual_outcome?: string | null
          expected_outcome?: string | null
          id?: never
          input_data?: Json | null
          notes?: string | null
          passed?: boolean | null
          test_type: string
          tested_at?: string | null
        }
        Update: {
          actual_outcome?: string | null
          expected_outcome?: string | null
          id?: never
          input_data?: Json | null
          notes?: string | null
          passed?: boolean | null
          test_type?: string
          tested_at?: string | null
        }
        Relationships: []
      }
      harmonic_cycles: {
        Row: {
          asset: string
          comma_gap_at_detection: number | null
          cwt_coherence_score: number | null
          cycle_phase: string | null
          detected_at: string
          dominant_frequency_hours: number | null
          emd_amplitude: number | null
          fractal_echo_detected: boolean | null
          hurst_long: number | null
          hurst_short: number | null
          id: number
          regime_id: number | null
          resonance_score: number | null
        }
        Insert: {
          asset: string
          comma_gap_at_detection?: number | null
          cwt_coherence_score?: number | null
          cycle_phase?: string | null
          detected_at?: string
          dominant_frequency_hours?: number | null
          emd_amplitude?: number | null
          fractal_echo_detected?: boolean | null
          hurst_long?: number | null
          hurst_short?: number | null
          id?: number
          regime_id?: number | null
          resonance_score?: number | null
        }
        Update: {
          asset?: string
          comma_gap_at_detection?: number | null
          cwt_coherence_score?: number | null
          cycle_phase?: string | null
          detected_at?: string
          dominant_frequency_hours?: number | null
          emd_amplitude?: number | null
          fractal_echo_detected?: boolean | null
          hurst_long?: number | null
          hurst_short?: number | null
          id?: number
          regime_id?: number | null
          resonance_score?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "harmonic_cycles_regime_id_fkey"
            columns: ["regime_id"]
            isOneToOne: false
            referencedRelation: "prediction_regimes"
            referencedColumns: ["id"]
          },
        ]
      }
      healing_bugs: {
        Row: {
          bug_code: string
          description: string | null
          error_signature: string | null
          files_affected: string[] | null
          first_seen: string | null
          id: string
          last_seen: string | null
          root_cause: string | null
          severity: string | null
          status: string | null
          times_encountered: number | null
          title: string
        }
        Insert: {
          bug_code: string
          description?: string | null
          error_signature?: string | null
          files_affected?: string[] | null
          first_seen?: string | null
          id?: string
          last_seen?: string | null
          root_cause?: string | null
          severity?: string | null
          status?: string | null
          times_encountered?: number | null
          title: string
        }
        Update: {
          bug_code?: string
          description?: string | null
          error_signature?: string | null
          files_affected?: string[] | null
          first_seen?: string | null
          id?: string
          last_seen?: string | null
          root_cause?: string | null
          severity?: string | null
          status?: string | null
          times_encountered?: number | null
          title?: string
        }
        Relationships: []
      }
      healing_fixes: {
        Row: {
          applied_at: string | null
          applied_by: string | null
          bug_id: string | null
          code_changes: Json | null
          fix_description: string
          fix_type: string | null
          id: string
          notes: string | null
          verification_method: string | null
          verification_result: string | null
          verified_at: string | null
          verified_by: string | null
        }
        Insert: {
          applied_at?: string | null
          applied_by?: string | null
          bug_id?: string | null
          code_changes?: Json | null
          fix_description: string
          fix_type?: string | null
          id?: string
          notes?: string | null
          verification_method?: string | null
          verification_result?: string | null
          verified_at?: string | null
          verified_by?: string | null
        }
        Update: {
          applied_at?: string | null
          applied_by?: string | null
          bug_id?: string | null
          code_changes?: Json | null
          fix_description?: string
          fix_type?: string | null
          id?: string
          notes?: string | null
          verification_method?: string | null
          verification_result?: string | null
          verified_at?: string | null
          verified_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "healing_fixes_bug_id_fkey"
            columns: ["bug_id"]
            isOneToOne: false
            referencedRelation: "healing_active_bugs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "healing_fixes_bug_id_fkey"
            columns: ["bug_id"]
            isOneToOne: false
            referencedRelation: "healing_bugs"
            referencedColumns: ["id"]
          },
        ]
      }
      healing_patterns: {
        Row: {
          created_at: string | null
          id: string
          pattern_name: string
          prevention_rule: string | null
          recommended_fix: string | null
          root_cause_category: string | null
          success_rate: number | null
          symptoms: string[] | null
          times_matched: number | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          pattern_name: string
          prevention_rule?: string | null
          recommended_fix?: string | null
          root_cause_category?: string | null
          success_rate?: number | null
          symptoms?: string[] | null
          times_matched?: number | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          pattern_name?: string
          prevention_rule?: string | null
          recommended_fix?: string | null
          root_cause_category?: string | null
          success_rate?: number | null
          symptoms?: string[] | null
          times_matched?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      healing_requests: {
        Row: {
          bug_id: string | null
          claimed_at: string | null
          completed_at: string | null
          context: Json | null
          id: string
          request_type: string | null
          requested_at: string | null
          requesting_agent: string
          response: Json | null
          status: string | null
          target_agent: string | null
        }
        Insert: {
          bug_id?: string | null
          claimed_at?: string | null
          completed_at?: string | null
          context?: Json | null
          id?: string
          request_type?: string | null
          requested_at?: string | null
          requesting_agent: string
          response?: Json | null
          status?: string | null
          target_agent?: string | null
        }
        Update: {
          bug_id?: string | null
          claimed_at?: string | null
          completed_at?: string | null
          context?: Json | null
          id?: string
          request_type?: string | null
          requested_at?: string | null
          requesting_agent?: string
          response?: Json | null
          status?: string | null
          target_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "healing_requests_bug_id_fkey"
            columns: ["bug_id"]
            isOneToOne: false
            referencedRelation: "healing_active_bugs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "healing_requests_bug_id_fkey"
            columns: ["bug_id"]
            isOneToOne: false
            referencedRelation: "healing_bugs"
            referencedColumns: ["id"]
          },
        ]
      }
      healing_rules: {
        Row: {
          bounty_matic: number | null
          condition_check: string | null
          cooldown_minutes: number | null
          created_at: string | null
          healing_action: string | null
          id: string
          last_failure_reason: string | null
          requires_approval: boolean | null
          rule_name: string
          success_rate: number | null
          trigger_count: number | null
        }
        Insert: {
          bounty_matic?: number | null
          condition_check?: string | null
          cooldown_minutes?: number | null
          created_at?: string | null
          healing_action?: string | null
          id?: string
          last_failure_reason?: string | null
          requires_approval?: boolean | null
          rule_name: string
          success_rate?: number | null
          trigger_count?: number | null
        }
        Update: {
          bounty_matic?: number | null
          condition_check?: string | null
          cooldown_minutes?: number | null
          created_at?: string | null
          healing_action?: string | null
          id?: string
          last_failure_reason?: string | null
          requires_approval?: boolean | null
          rule_name?: string
          success_rate?: number | null
          trigger_count?: number | null
        }
        Relationships: []
      }
      health_checks: {
        Row: {
          agent: string
          checked_at: string | null
          details: Json | null
          errors_detected: number | null
          healing_triggered: boolean | null
          id: string
          status: string | null
        }
        Insert: {
          agent: string
          checked_at?: string | null
          details?: Json | null
          errors_detected?: number | null
          healing_triggered?: boolean | null
          id?: string
          status?: string | null
        }
        Update: {
          agent?: string
          checked_at?: string | null
          details?: Json | null
          errors_detected?: number | null
          healing_triggered?: boolean | null
          id?: string
          status?: string | null
        }
        Relationships: []
      }
      historical_wisdom_activations: {
        Row: {
          activated_at: string | null
          activating_agent: string
          confidence_after: number | null
          confidence_before: number | null
          conflict_detected: boolean | null
          conflict_resolution: string | null
          cycle_id: string | null
          id: number
          lle_at_time: number | null
          regime_at_time: string | null
          signal_impact: number | null
          was_correct: boolean | null
          wisdom_category: string | null
          wisdom_key: string
        }
        Insert: {
          activated_at?: string | null
          activating_agent: string
          confidence_after?: number | null
          confidence_before?: number | null
          conflict_detected?: boolean | null
          conflict_resolution?: string | null
          cycle_id?: string | null
          id?: number
          lle_at_time?: number | null
          regime_at_time?: string | null
          signal_impact?: number | null
          was_correct?: boolean | null
          wisdom_category?: string | null
          wisdom_key: string
        }
        Update: {
          activated_at?: string | null
          activating_agent?: string
          confidence_after?: number | null
          confidence_before?: number | null
          conflict_detected?: boolean | null
          conflict_resolution?: string | null
          cycle_id?: string | null
          id?: number
          lle_at_time?: number | null
          regime_at_time?: string | null
          signal_impact?: number | null
          was_correct?: boolean | null
          wisdom_category?: string | null
          wisdom_key?: string
        }
        Relationships: [
          {
            foreignKeyName: "historical_wisdom_activations_cycle_id_fkey"
            columns: ["cycle_id"]
            isOneToOne: false
            referencedRelation: "prediction_consensus"
            referencedColumns: ["cycle_id"]
          },
        ]
      }
      hitl_hunch_log: {
        Row: {
          asset: string | null
          comma_severity_at_time: string | null
          confidence_in_self: number | null
          cycle_id: string | null
          decided_at: string | null
          external_context: string | null
          hias_delta: number | null
          human_decision: string | null
          hunch_added_value: boolean | null
          hunch_category: string
          hunch_note: string | null
          hunch_was_correct: boolean | null
          id: number
          operator_id: string
          outcome_notes: string | null
          outcome_recorded_at: string | null
          override_reason: string | null
          override_system: boolean | null
          regime_at_time: string | null
          system_confidence: number | null
          system_signal: string | null
          system_was_correct: boolean | null
        }
        Insert: {
          asset?: string | null
          comma_severity_at_time?: string | null
          confidence_in_self?: number | null
          cycle_id?: string | null
          decided_at?: string | null
          external_context?: string | null
          hias_delta?: number | null
          human_decision?: string | null
          hunch_added_value?: boolean | null
          hunch_category: string
          hunch_note?: string | null
          hunch_was_correct?: boolean | null
          id?: number
          operator_id?: string
          outcome_notes?: string | null
          outcome_recorded_at?: string | null
          override_reason?: string | null
          override_system?: boolean | null
          regime_at_time?: string | null
          system_confidence?: number | null
          system_signal?: string | null
          system_was_correct?: boolean | null
        }
        Update: {
          asset?: string | null
          comma_severity_at_time?: string | null
          confidence_in_self?: number | null
          cycle_id?: string | null
          decided_at?: string | null
          external_context?: string | null
          hias_delta?: number | null
          human_decision?: string | null
          hunch_added_value?: boolean | null
          hunch_category?: string
          hunch_note?: string | null
          hunch_was_correct?: boolean | null
          id?: number
          operator_id?: string
          outcome_notes?: string | null
          outcome_recorded_at?: string | null
          override_reason?: string | null
          override_system?: boolean | null
          regime_at_time?: string | null
          system_confidence?: number | null
          system_signal?: string | null
          system_was_correct?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "hitl_hunch_log_cycle_id_fkey"
            columns: ["cycle_id"]
            isOneToOne: false
            referencedRelation: "prediction_consensus"
            referencedColumns: ["cycle_id"]
          },
        ]
      }
      hitl_requests: {
        Row: {
          assigned_to: string | null
          created_at: string
          expires_at: string
          id: string
          metadata: Json
          priority: number
          request_context: Json
          request_reason: string
          resolution: string | null
          resolution_notes: string | null
          resolved_at: string | null
          status: string
          task_id: number
          validation_queue_id: string | null
        }
        Insert: {
          assigned_to?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          metadata?: Json
          priority?: number
          request_context?: Json
          request_reason: string
          resolution?: string | null
          resolution_notes?: string | null
          resolved_at?: string | null
          status?: string
          task_id: number
          validation_queue_id?: string | null
        }
        Update: {
          assigned_to?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          metadata?: Json
          priority?: number
          request_context?: Json
          request_reason?: string
          resolution?: string | null
          resolution_notes?: string | null
          resolved_at?: string | null
          status?: string
          task_id?: number
          validation_queue_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "hitl_requests_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "trinity_post_task_lag"
            referencedColumns: ["task_id"]
          },
          {
            foreignKeyName: "hitl_requests_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "trinity_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hitl_requests_validation_queue_id_fkey"
            columns: ["validation_queue_id"]
            isOneToOne: false
            referencedRelation: "validation_queue"
            referencedColumns: ["id"]
          },
        ]
      }
      hitl_settings: {
        Row: {
          id: number
          settings: Json | null
          slider_value: string | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          id?: number
          settings?: Json | null
          slider_value?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          id?: number
          settings?: Json | null
          slider_value?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      human_intuition_scores: {
        Row: {
          asset: string | null
          best_asset: string | null
          best_regime: string | null
          comma_trigger_active: boolean | null
          confidence_reduction_active: boolean | null
          correct_hunches: number | null
          hias_score: number | null
          hunch_category: string
          id: number
          operator_id: string
          regime_type: string | null
          system_weight_modifier: number | null
          total_hunches: number | null
          updated_at: string | null
          veto_power_active: boolean | null
        }
        Insert: {
          asset?: string | null
          best_asset?: string | null
          best_regime?: string | null
          comma_trigger_active?: boolean | null
          confidence_reduction_active?: boolean | null
          correct_hunches?: number | null
          hias_score?: number | null
          hunch_category: string
          id?: number
          operator_id: string
          regime_type?: string | null
          system_weight_modifier?: number | null
          total_hunches?: number | null
          updated_at?: string | null
          veto_power_active?: boolean | null
        }
        Update: {
          asset?: string | null
          best_asset?: string | null
          best_regime?: string | null
          comma_trigger_active?: boolean | null
          confidence_reduction_active?: boolean | null
          correct_hunches?: number | null
          hias_score?: number | null
          hunch_category?: string
          id?: number
          operator_id?: string
          regime_type?: string | null
          system_weight_modifier?: number | null
          total_hunches?: number | null
          updated_at?: string | null
          veto_power_active?: boolean | null
        }
        Relationships: []
      }
      human_sbt_mints: {
        Row: {
          commitment_hash: string
          id: string
          minted_at: string | null
          repid: string | null
          wallet_address: string
        }
        Insert: {
          commitment_hash: string
          id?: string
          minted_at?: string | null
          repid?: string | null
          wallet_address: string
        }
        Update: {
          commitment_hash?: string
          id?: string
          minted_at?: string | null
          repid?: string | null
          wallet_address?: string
        }
        Relationships: []
      }
      human_sbt_registry: {
        Row: {
          active_custodianships: number | null
          biometric_verified: boolean | null
          conversion_proof: string | null
          created_at: string | null
          dbt_token_id: string | null
          email_verified: boolean | null
          holder_zkp_proof: string
          honorable_exits: number | null
          id: number
          institution_id: string | null
          non_transferable: boolean | null
          on_chain_block: number | null
          on_chain_tx_hash: string | null
          phone_verified: boolean | null
          pol_timestamp: string | null
          qualification_tier: string | null
          repid_score: number | null
          token_id: string
          total_agents_graduated: number | null
          verification_method: string | null
          verification_timestamp: string | null
          wallet_address: string | null
          wallet_sig_verified: boolean | null
        }
        Insert: {
          active_custodianships?: number | null
          biometric_verified?: boolean | null
          conversion_proof?: string | null
          created_at?: string | null
          dbt_token_id?: string | null
          email_verified?: boolean | null
          holder_zkp_proof: string
          honorable_exits?: number | null
          id?: number
          institution_id?: string | null
          non_transferable?: boolean | null
          on_chain_block?: number | null
          on_chain_tx_hash?: string | null
          phone_verified?: boolean | null
          pol_timestamp?: string | null
          qualification_tier?: string | null
          repid_score?: number | null
          token_id: string
          total_agents_graduated?: number | null
          verification_method?: string | null
          verification_timestamp?: string | null
          wallet_address?: string | null
          wallet_sig_verified?: boolean | null
        }
        Update: {
          active_custodianships?: number | null
          biometric_verified?: boolean | null
          conversion_proof?: string | null
          created_at?: string | null
          dbt_token_id?: string | null
          email_verified?: boolean | null
          holder_zkp_proof?: string
          honorable_exits?: number | null
          id?: number
          institution_id?: string | null
          non_transferable?: boolean | null
          on_chain_block?: number | null
          on_chain_tx_hash?: string | null
          phone_verified?: boolean | null
          pol_timestamp?: string | null
          qualification_tier?: string | null
          repid_score?: number | null
          token_id?: string
          total_agents_graduated?: number | null
          verification_method?: string | null
          verification_timestamp?: string | null
          wallet_address?: string | null
          wallet_sig_verified?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "human_sbt_registry_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institution_config"
            referencedColumns: ["institution_id"]
          },
        ]
      }
      hyperdag_activity_catalog: {
        Row: {
          activity_type: string
          created_at: string | null
          description: string | null
          display_name: string
          is_active: boolean | null
          max_lifetime: number | null
          max_per_day: number | null
          points_base: number
          points_multiplier: number | null
        }
        Insert: {
          activity_type: string
          created_at?: string | null
          description?: string | null
          display_name: string
          is_active?: boolean | null
          max_lifetime?: number | null
          max_per_day?: number | null
          points_base: number
          points_multiplier?: number | null
        }
        Update: {
          activity_type?: string
          created_at?: string | null
          description?: string | null
          display_name?: string
          is_active?: boolean | null
          max_lifetime?: number | null
          max_per_day?: number | null
          points_base?: number
          points_multiplier?: number | null
        }
        Relationships: []
      }
      hyperdag_ecosystem_registry: {
        Row: {
          display_name: string
          ecosystem_key: string
          is_active: boolean | null
          launched_at: string | null
          notes: string | null
          product_url: string | null
        }
        Insert: {
          display_name: string
          ecosystem_key: string
          is_active?: boolean | null
          launched_at?: string | null
          notes?: string | null
          product_url?: string | null
        }
        Update: {
          display_name?: string
          ecosystem_key?: string
          is_active?: boolean | null
          launched_at?: string | null
          notes?: string | null
          product_url?: string | null
        }
        Relationships: []
      }
      hyperdag_governance_weights: {
        Row: {
          decay_rate: number | null
          email: string | null
          erc8004_token_id: string | null
          governance_weight: number | null
          id: number
          last_activity_at: string | null
          repid_score: number | null
          token_balance: number | null
          updated_at: string | null
        }
        Insert: {
          decay_rate?: number | null
          email?: string | null
          erc8004_token_id?: string | null
          governance_weight?: number | null
          id?: number
          last_activity_at?: string | null
          repid_score?: number | null
          token_balance?: number | null
          updated_at?: string | null
        }
        Update: {
          decay_rate?: number | null
          email?: string | null
          erc8004_token_id?: string | null
          governance_weight?: number | null
          id?: number
          last_activity_at?: string | null
          repid_score?: number | null
          token_balance?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      hyperdag_nodes: {
        Row: {
          chaos_level: number | null
          connectedto: string[] | null
          created_at: string | null
          id: string
          label: string | null
        }
        Insert: {
          chaos_level?: number | null
          connectedto?: string[] | null
          created_at?: string | null
          id?: string
          label?: string | null
        }
        Update: {
          chaos_level?: number | null
          connectedto?: string[] | null
          created_at?: string | null
          id?: string
          label?: string | null
        }
        Relationships: []
      }
      hyperdag_points_ledger: {
        Row: {
          activity_type: string
          conversion_eligible: boolean | null
          created_at: string | null
          ecosystem_source: string
          email: string | null
          email_hash: string | null
          id: number
          is_sweat_equity: boolean | null
          metadata: Json | null
          nickname: string | null
          points_awarded: number
          reverted_at: string | null
          reverted_to_dao: boolean | null
          speculation_purchase: boolean | null
          token_equivalent_ratio: number | null
          token_lockup_expires_at: string | null
          user_id: string | null
          vertical: string
          vested: boolean | null
          void_reason: string | null
          voided: boolean | null
          voided_at: string | null
        }
        Insert: {
          activity_type: string
          conversion_eligible?: boolean | null
          created_at?: string | null
          ecosystem_source: string
          email?: string | null
          email_hash?: string | null
          id?: number
          is_sweat_equity?: boolean | null
          metadata?: Json | null
          nickname?: string | null
          points_awarded: number
          reverted_at?: string | null
          reverted_to_dao?: boolean | null
          speculation_purchase?: boolean | null
          token_equivalent_ratio?: number | null
          token_lockup_expires_at?: string | null
          user_id?: string | null
          vertical: string
          vested?: boolean | null
          void_reason?: string | null
          voided?: boolean | null
          voided_at?: string | null
        }
        Update: {
          activity_type?: string
          conversion_eligible?: boolean | null
          created_at?: string | null
          ecosystem_source?: string
          email?: string | null
          email_hash?: string | null
          id?: number
          is_sweat_equity?: boolean | null
          metadata?: Json | null
          nickname?: string | null
          points_awarded?: number
          reverted_at?: string | null
          reverted_to_dao?: boolean | null
          speculation_purchase?: boolean | null
          token_equivalent_ratio?: number | null
          token_lockup_expires_at?: string | null
          user_id?: string | null
          vertical?: string
          vested?: boolean | null
          void_reason?: string | null
          voided?: boolean | null
          voided_at?: string | null
        }
        Relationships: []
      }
      hyperdag_receipts: {
        Row: {
          agent_id: number
          committer_address: string
          contract_block_number: number | null
          contract_receipt_id: string | null
          contract_tx_hash: string | null
          created_at: string
          hal_bounded_score: number
          hal_comma_bft_verdict: number
          hal_dimensions_hash: string
          hal_dof_version: number
          hal_output_hash: string
          human_identity_root: string | null
          invalidated_at: string | null
          invalidation_reason: string | null
          receipt_content_hash: string
          receipt_id: string
          receipt_json: Json
          receipt_uri: string
          receipt_uri_hash: string | null
          rep_id_commitment: string
          result_hash: string
          score_version: number
          status: number
          task_hash: string
          x402_payment_hash: string
        }
        Insert: {
          agent_id: number
          committer_address: string
          contract_block_number?: number | null
          contract_receipt_id?: string | null
          contract_tx_hash?: string | null
          created_at?: string
          hal_bounded_score: number
          hal_comma_bft_verdict: number
          hal_dimensions_hash: string
          hal_dof_version: number
          hal_output_hash: string
          human_identity_root?: string | null
          invalidated_at?: string | null
          invalidation_reason?: string | null
          receipt_content_hash: string
          receipt_id: string
          receipt_json: Json
          receipt_uri?: string
          receipt_uri_hash?: string | null
          rep_id_commitment: string
          result_hash: string
          score_version: number
          status?: number
          task_hash: string
          x402_payment_hash: string
        }
        Update: {
          agent_id?: number
          committer_address?: string
          contract_block_number?: number | null
          contract_receipt_id?: string | null
          contract_tx_hash?: string | null
          created_at?: string
          hal_bounded_score?: number
          hal_comma_bft_verdict?: number
          hal_dimensions_hash?: string
          hal_dof_version?: number
          hal_output_hash?: string
          human_identity_root?: string | null
          invalidated_at?: string | null
          invalidation_reason?: string | null
          receipt_content_hash?: string
          receipt_id?: string
          receipt_json?: Json
          receipt_uri?: string
          receipt_uri_hash?: string | null
          rep_id_commitment?: string
          result_hash?: string
          score_version?: number
          status?: number
          task_hash?: string
          x402_payment_hash?: string
        }
        Relationships: []
      }
      hyperdag_token_config: {
        Row: {
          config_key: string
          config_value: string | null
          description: string | null
          id: number
          is_locked: boolean | null
          updated_at: string | null
        }
        Insert: {
          config_key: string
          config_value?: string | null
          description?: string | null
          id?: number
          is_locked?: boolean | null
          updated_at?: string | null
        }
        Update: {
          config_key?: string
          config_value?: string | null
          description?: string | null
          id?: number
          is_locked?: boolean | null
          updated_at?: string | null
        }
        Relationships: []
      }
      idea_backlog: {
        Row: {
          created_at: string | null
          ice_score: number | null
          id: number
          last_touched_at: string | null
          north_star_candidate: string | null
          one_sentence: string | null
          rice_score: number | null
          status: string | null
          title: string
          voc_signals_count: number | null
        }
        Insert: {
          created_at?: string | null
          ice_score?: number | null
          id?: number
          last_touched_at?: string | null
          north_star_candidate?: string | null
          one_sentence?: string | null
          rice_score?: number | null
          status?: string | null
          title: string
          voc_signals_count?: number | null
        }
        Update: {
          created_at?: string | null
          ice_score?: number | null
          id?: number
          last_touched_at?: string | null
          north_star_candidate?: string | null
          one_sentence?: string | null
          rice_score?: number | null
          status?: string | null
          title?: string
          voc_signals_count?: number | null
        }
        Relationships: []
      }
      idea_injections: {
        Row: {
          author_email: string | null
          author_name: string | null
          content: string
          created_at: string | null
          id: number
          parent_id: number | null
          snapshot_id: number | null
          status: string | null
          task_id: number | null
          type: string | null
          upvotes: number | null
        }
        Insert: {
          author_email?: string | null
          author_name?: string | null
          content: string
          created_at?: string | null
          id?: number
          parent_id?: number | null
          snapshot_id?: number | null
          status?: string | null
          task_id?: number | null
          type?: string | null
          upvotes?: number | null
        }
        Update: {
          author_email?: string | null
          author_name?: string | null
          content?: string
          created_at?: string | null
          id?: number
          parent_id?: number | null
          snapshot_id?: number | null
          status?: string | null
          task_id?: number | null
          type?: string | null
          upvotes?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "idea_injections_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "idea_injections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "idea_injections_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "trinity_post_task_lag"
            referencedColumns: ["task_id"]
          },
          {
            foreignKeyName: "idea_injections_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "trinity_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      ideas: {
        Row: {
          category: string | null
          created_at: string | null
          created_by: string | null
          description: string | null
          id: number
          metadata: Json | null
          priority: number | null
          status: string | null
          title: string
          updated_at: string | null
          workspace_id: string | null
        }
        Insert: {
          category?: string | null
          created_at?: string | null
          created_by?: string | null
          description?: string | null
          id?: number
          metadata?: Json | null
          priority?: number | null
          status?: string | null
          title: string
          updated_at?: string | null
          workspace_id?: string | null
        }
        Update: {
          category?: string | null
          created_at?: string | null
          created_by?: string | null
          description?: string | null
          id?: number
          metadata?: Json | null
          priority?: number | null
          status?: string | null
          title?: string
          updated_at?: string | null
          workspace_id?: string | null
        }
        Relationships: []
      }
      ideas_backlog: {
        Row: {
          category: string | null
          created_at: string | null
          id: string
          idea: string
          priority: number | null
          source: string | null
          status: string | null
        }
        Insert: {
          category?: string | null
          created_at?: string | null
          id?: string
          idea: string
          priority?: number | null
          source?: string | null
          status?: string | null
        }
        Update: {
          category?: string | null
          created_at?: string | null
          id?: string
          idea?: string
          priority?: number | null
          source?: string | null
          status?: string | null
        }
        Relationships: []
      }
      ideation: {
        Row: {
          category: string
          created_at: string | null
          description: string | null
          evaluated_at: string | null
          id: string
          implemented_at: string | null
          notes: string | null
          patent_relevant: boolean | null
          priority: number | null
          related_task_id: number | null
          source: string | null
          status: string | null
          tags: string[] | null
          title: string
        }
        Insert: {
          category: string
          created_at?: string | null
          description?: string | null
          evaluated_at?: string | null
          id?: string
          implemented_at?: string | null
          notes?: string | null
          patent_relevant?: boolean | null
          priority?: number | null
          related_task_id?: number | null
          source?: string | null
          status?: string | null
          tags?: string[] | null
          title: string
        }
        Update: {
          category?: string
          created_at?: string | null
          description?: string | null
          evaluated_at?: string | null
          id?: string
          implemented_at?: string | null
          notes?: string | null
          patent_relevant?: boolean | null
          priority?: number | null
          related_task_id?: number | null
          source?: string | null
          status?: string | null
          tags?: string[] | null
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "ideation_related_task_id_fkey"
            columns: ["related_task_id"]
            isOneToOne: false
            referencedRelation: "trinity_post_task_lag"
            referencedColumns: ["task_id"]
          },
          {
            foreignKeyName: "ideation_related_task_id_fkey"
            columns: ["related_task_id"]
            isOneToOne: false
            referencedRelation: "trinity_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      ideation_log: {
        Row: {
          captured_by: string | null
          created_at: string | null
          id: string
          priority: number | null
          project: string | null
          promoted_to_task_id: number | null
          raw_text: string
          source: string | null
          status: string | null
        }
        Insert: {
          captured_by?: string | null
          created_at?: string | null
          id?: string
          priority?: number | null
          project?: string | null
          promoted_to_task_id?: number | null
          raw_text: string
          source?: string | null
          status?: string | null
        }
        Update: {
          captured_by?: string | null
          created_at?: string | null
          id?: string
          priority?: number | null
          project?: string | null
          promoted_to_task_id?: number | null
          raw_text?: string
          source?: string | null
          status?: string | null
        }
        Relationships: []
      }
      indexer_state: {
        Row: {
          error_count: number
          last_block: number
          last_error: string | null
          last_run_at: string
          service_name: string
        }
        Insert: {
          error_count?: number
          last_block?: number
          last_error?: string | null
          last_run_at?: string
          service_name: string
        }
        Update: {
          error_count?: number
          last_block?: number
          last_error?: string | null
          last_run_at?: string
          service_name?: string
        }
        Relationships: []
      }
      influencer_rep_scores: {
        Row: {
          accuracy_score: number | null
          committee_affiliation: string | null
          committee_weight: number | null
          consensus_score: number | null
          correct_signals: number | null
          display_name: string
          id: number
          impact_score: number | null
          influencer_id: string
          is_congressional: boolean | null
          is_corporate_insider: boolean | null
          last_calibration_at: string | null
          last_signal_at: string | null
          notes: string | null
          rep_score: number
          tier: number | null
          total_signals: number | null
        }
        Insert: {
          accuracy_score?: number | null
          committee_affiliation?: string | null
          committee_weight?: number | null
          consensus_score?: number | null
          correct_signals?: number | null
          display_name: string
          id?: number
          impact_score?: number | null
          influencer_id: string
          is_congressional?: boolean | null
          is_corporate_insider?: boolean | null
          last_calibration_at?: string | null
          last_signal_at?: string | null
          notes?: string | null
          rep_score: number
          tier?: number | null
          total_signals?: number | null
        }
        Update: {
          accuracy_score?: number | null
          committee_affiliation?: string | null
          committee_weight?: number | null
          consensus_score?: number | null
          correct_signals?: number | null
          display_name?: string
          id?: number
          impact_score?: number | null
          influencer_id?: string
          is_congressional?: boolean | null
          is_corporate_insider?: boolean | null
          last_calibration_at?: string | null
          last_signal_at?: string | null
          notes?: string | null
          rep_score?: number
          tier?: number | null
          total_signals?: number | null
        }
        Relationships: []
      }
      innovation_metrics: {
        Row: {
          created_at: string | null
          id: number
          measurement_date: string | null
          metric_name: string
          metric_type: string
          metric_value: number | null
          notes: string | null
          project_name: string
          source: string | null
          target_value: number | null
        }
        Insert: {
          created_at?: string | null
          id?: number
          measurement_date?: string | null
          metric_name: string
          metric_type: string
          metric_value?: number | null
          notes?: string | null
          project_name: string
          source?: string | null
          target_value?: number | null
        }
        Update: {
          created_at?: string | null
          id?: number
          measurement_date?: string | null
          metric_name?: string
          metric_type?: string
          metric_value?: number | null
          notes?: string | null
          project_name?: string
          source?: string | null
          target_value?: number | null
        }
        Relationships: []
      }
      insider_trading_signals: {
        Row: {
          actor_committee: string | null
          actor_id: string | null
          actor_name: string
          amount_midpoint_usd: number | null
          amount_range: string | null
          asset_traded: string
          committee_weight: number | null
          congress_score: number | null
          crypto_relevance: number | null
          data_source: string | null
          detected_at: string | null
          disclosure_date: string
          effective_signal_strength: number | null
          historical_accuracy: number | null
          id: number
          lag_days: number | null
          sell_amplified: boolean | null
          source_type: string
          trade_date: string | null
          trade_direction: string | null
          w3c_source_url: string | null
        }
        Insert: {
          actor_committee?: string | null
          actor_id?: string | null
          actor_name: string
          amount_midpoint_usd?: number | null
          amount_range?: string | null
          asset_traded: string
          committee_weight?: number | null
          congress_score?: number | null
          crypto_relevance?: number | null
          data_source?: string | null
          detected_at?: string | null
          disclosure_date: string
          effective_signal_strength?: number | null
          historical_accuracy?: number | null
          id?: number
          lag_days?: number | null
          sell_amplified?: boolean | null
          source_type: string
          trade_date?: string | null
          trade_direction?: string | null
          w3c_source_url?: string | null
        }
        Update: {
          actor_committee?: string | null
          actor_id?: string | null
          actor_name?: string
          amount_midpoint_usd?: number | null
          amount_range?: string | null
          asset_traded?: string
          committee_weight?: number | null
          congress_score?: number | null
          crypto_relevance?: number | null
          data_source?: string | null
          detected_at?: string | null
          disclosure_date?: string
          effective_signal_strength?: number | null
          historical_accuracy?: number | null
          id?: number
          lag_days?: number | null
          sell_amplified?: boolean | null
          source_type?: string
          trade_date?: string | null
          trade_direction?: string | null
          w3c_source_url?: string | null
        }
        Relationships: []
      }
      institution_config: {
        Row: {
          aggregate_alert_pct: number | null
          allowed_days: string[] | null
          allowed_hours_end: number | null
          allowed_hours_start: number | null
          alpha_protection_mode: boolean | null
          approved_llm_providers: string[] | null
          auto_sar_threshold_usdc: number | null
          auto_suspend_on_alert: boolean | null
          bft_min_llms: number | null
          bft_min_repid: number | null
          board_notification_threshold: number | null
          byok_config: Json | null
          counterparty_whitelist_only: boolean | null
          fireblocks_policy_id: string | null
          fireblocks_preauth_enabled: boolean | null
          freeze_requires_dual_unfreeze: boolean | null
          frozen: boolean | null
          frozen_at: string | null
          frozen_by: string | null
          high_security_min_llms: number | null
          high_security_min_repid: number | null
          high_security_mode: boolean | null
          human_custody_threshold_usdc: number | null
          id: number
          institution_id: string
          institution_name: string
          jurisdiction_allowlist: string[] | null
          max_aggregate_daily_usdc: number | null
          min_agent_trust_requirement: string | null
          min_repid_payment: number | null
          min_repid_single_llm_override: number | null
          min_repid_vault: number | null
          mobile_auth_method: string | null
          mobile_auth_required_above: number | null
          mobile_auth_timeout_seconds: number | null
          new_counterparty_requires_dual_sig: boolean | null
          notify_on_dual_sig_request: boolean | null
          notify_on_suspicious_pattern: boolean | null
          pythagorean_veto_enabled: boolean | null
          receipt_includes_llm_votes: boolean | null
          regulatory_profile: string | null
          repid_decay_rate_daily: number | null
          require_compliance_receipt: boolean | null
          require_human_custody_payment: boolean | null
          require_human_custody_vault: boolean | null
          require_provider_diversity: boolean | null
          sanctions_refresh_hours: number | null
          trading_hours_only: boolean | null
          updated_at: string | null
          updated_by: string | null
          veto_suspicion_threshold: number | null
        }
        Insert: {
          aggregate_alert_pct?: number | null
          allowed_days?: string[] | null
          allowed_hours_end?: number | null
          allowed_hours_start?: number | null
          alpha_protection_mode?: boolean | null
          approved_llm_providers?: string[] | null
          auto_sar_threshold_usdc?: number | null
          auto_suspend_on_alert?: boolean | null
          bft_min_llms?: number | null
          bft_min_repid?: number | null
          board_notification_threshold?: number | null
          byok_config?: Json | null
          counterparty_whitelist_only?: boolean | null
          fireblocks_policy_id?: string | null
          fireblocks_preauth_enabled?: boolean | null
          freeze_requires_dual_unfreeze?: boolean | null
          frozen?: boolean | null
          frozen_at?: string | null
          frozen_by?: string | null
          high_security_min_llms?: number | null
          high_security_min_repid?: number | null
          high_security_mode?: boolean | null
          human_custody_threshold_usdc?: number | null
          id?: number
          institution_id?: string
          institution_name?: string
          jurisdiction_allowlist?: string[] | null
          max_aggregate_daily_usdc?: number | null
          min_agent_trust_requirement?: string | null
          min_repid_payment?: number | null
          min_repid_single_llm_override?: number | null
          min_repid_vault?: number | null
          mobile_auth_method?: string | null
          mobile_auth_required_above?: number | null
          mobile_auth_timeout_seconds?: number | null
          new_counterparty_requires_dual_sig?: boolean | null
          notify_on_dual_sig_request?: boolean | null
          notify_on_suspicious_pattern?: boolean | null
          pythagorean_veto_enabled?: boolean | null
          receipt_includes_llm_votes?: boolean | null
          regulatory_profile?: string | null
          repid_decay_rate_daily?: number | null
          require_compliance_receipt?: boolean | null
          require_human_custody_payment?: boolean | null
          require_human_custody_vault?: boolean | null
          require_provider_diversity?: boolean | null
          sanctions_refresh_hours?: number | null
          trading_hours_only?: boolean | null
          updated_at?: string | null
          updated_by?: string | null
          veto_suspicion_threshold?: number | null
        }
        Update: {
          aggregate_alert_pct?: number | null
          allowed_days?: string[] | null
          allowed_hours_end?: number | null
          allowed_hours_start?: number | null
          alpha_protection_mode?: boolean | null
          approved_llm_providers?: string[] | null
          auto_sar_threshold_usdc?: number | null
          auto_suspend_on_alert?: boolean | null
          bft_min_llms?: number | null
          bft_min_repid?: number | null
          board_notification_threshold?: number | null
          byok_config?: Json | null
          counterparty_whitelist_only?: boolean | null
          fireblocks_policy_id?: string | null
          fireblocks_preauth_enabled?: boolean | null
          freeze_requires_dual_unfreeze?: boolean | null
          frozen?: boolean | null
          frozen_at?: string | null
          frozen_by?: string | null
          high_security_min_llms?: number | null
          high_security_min_repid?: number | null
          high_security_mode?: boolean | null
          human_custody_threshold_usdc?: number | null
          id?: number
          institution_id?: string
          institution_name?: string
          jurisdiction_allowlist?: string[] | null
          max_aggregate_daily_usdc?: number | null
          min_agent_trust_requirement?: string | null
          min_repid_payment?: number | null
          min_repid_single_llm_override?: number | null
          min_repid_vault?: number | null
          mobile_auth_method?: string | null
          mobile_auth_required_above?: number | null
          mobile_auth_timeout_seconds?: number | null
          new_counterparty_requires_dual_sig?: boolean | null
          notify_on_dual_sig_request?: boolean | null
          notify_on_suspicious_pattern?: boolean | null
          pythagorean_veto_enabled?: boolean | null
          receipt_includes_llm_votes?: boolean | null
          regulatory_profile?: string | null
          repid_decay_rate_daily?: number | null
          require_compliance_receipt?: boolean | null
          require_human_custody_payment?: boolean | null
          require_human_custody_vault?: boolean | null
          require_provider_diversity?: boolean | null
          sanctions_refresh_hours?: number | null
          trading_hours_only?: boolean | null
          updated_at?: string | null
          updated_by?: string | null
          veto_suspicion_threshold?: number | null
        }
        Relationships: []
      }
      institution_config_audit_log: {
        Row: {
          change_type: string
          changed_at: string | null
          changed_by: string
          field_changed: string | null
          id: number
          institution_id: string
          new_value: string | null
          old_value: string | null
          reason: string | null
        }
        Insert: {
          change_type: string
          changed_at?: string | null
          changed_by: string
          field_changed?: string | null
          id?: number
          institution_id: string
          new_value?: string | null
          old_value?: string | null
          reason?: string | null
        }
        Update: {
          change_type?: string
          changed_at?: string | null
          changed_by?: string
          field_changed?: string | null
          id?: number
          institution_id?: string
          new_value?: string | null
          old_value?: string | null
          reason?: string | null
        }
        Relationships: []
      }
      institution_risk_config: {
        Row: {
          created_at: string | null
          id: number
          institution_id: string
          institution_name: string
          min_repid_payment: number | null
          min_repid_vault: number | null
          repid_weights: Json
        }
        Insert: {
          created_at?: string | null
          id?: number
          institution_id?: string
          institution_name?: string
          min_repid_payment?: number | null
          min_repid_vault?: number | null
          repid_weights?: Json
        }
        Update: {
          created_at?: string | null
          id?: number
          institution_id?: string
          institution_name?: string
          min_repid_payment?: number | null
          min_repid_vault?: number | null
          repid_weights?: Json
        }
        Relationships: []
      }
      investor_targets: {
        Row: {
          created_at: string | null
          discovered_by: string | null
          email: string | null
          faith_aligned: boolean | null
          firm: string | null
          fit_score: number | null
          focus_areas: string[] | null
          id: string
          last_contact: string | null
          linkedin_url: string | null
          name: string
          next_action: string | null
          notes: string | null
          role: string | null
          source: string | null
          status: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          discovered_by?: string | null
          email?: string | null
          faith_aligned?: boolean | null
          firm?: string | null
          fit_score?: number | null
          focus_areas?: string[] | null
          id?: string
          last_contact?: string | null
          linkedin_url?: string | null
          name: string
          next_action?: string | null
          notes?: string | null
          role?: string | null
          source?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          discovered_by?: string | null
          email?: string | null
          faith_aligned?: boolean | null
          firm?: string | null
          fit_score?: number | null
          focus_areas?: string[] | null
          id?: string
          last_contact?: string | null
          linkedin_url?: string | null
          name?: string
          next_action?: string | null
          notes?: string | null
          role?: string | null
          source?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      invite_chains: {
        Row: {
          created_at: string | null
          generated_invite_id: string | null
          generation: number | null
          id: string
          original_invite_id: string | null
          source_type: string | null
        }
        Insert: {
          created_at?: string | null
          generated_invite_id?: string | null
          generation?: number | null
          id?: string
          original_invite_id?: string | null
          source_type?: string | null
        }
        Update: {
          created_at?: string | null
          generated_invite_id?: string | null
          generation?: number | null
          id?: string
          original_invite_id?: string | null
          source_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invite_chains_generated_invite_id_fkey"
            columns: ["generated_invite_id"]
            isOneToOne: false
            referencedRelation: "invites"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invite_chains_original_invite_id_fkey"
            columns: ["original_invite_id"]
            isOneToOne: false
            referencedRelation: "invites"
            referencedColumns: ["id"]
          },
        ]
      }
      invites: {
        Row: {
          code: string
          created_at: string | null
          created_by: string | null
          expires_at: string | null
          id: string
          invitee_category: string | null
          invitee_email: string | null
          invitee_name: string
          lead_id: string | null
          max_uses: number | null
          personalized_greeting: string | null
          status: string | null
          uses_count: number | null
        }
        Insert: {
          code: string
          created_at?: string | null
          created_by?: string | null
          expires_at?: string | null
          id?: string
          invitee_category?: string | null
          invitee_email?: string | null
          invitee_name: string
          lead_id?: string | null
          max_uses?: number | null
          personalized_greeting?: string | null
          status?: string | null
          uses_count?: number | null
        }
        Update: {
          code?: string
          created_at?: string | null
          created_by?: string | null
          expires_at?: string | null
          id?: string
          invitee_category?: string | null
          invitee_email?: string | null
          invitee_name?: string
          lead_id?: string | null
          max_uses?: number | null
          personalized_greeting?: string | null
          status?: string | null
          uses_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "invites_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      jurisdiction_rules: {
        Row: {
          country_name: string
          created_at: string | null
          id: number
          jurisdiction_code: string
          long_term_benefit: string | null
          long_term_threshold_days: number | null
          notes: string | null
          rebuy_restriction_days: number | null
          tax_free_after_days: number | null
          wash_sale_rule: boolean | null
        }
        Insert: {
          country_name: string
          created_at?: string | null
          id?: number
          jurisdiction_code: string
          long_term_benefit?: string | null
          long_term_threshold_days?: number | null
          notes?: string | null
          rebuy_restriction_days?: number | null
          tax_free_after_days?: number | null
          wash_sale_rule?: boolean | null
        }
        Update: {
          country_name?: string
          created_at?: string | null
          id?: number
          jurisdiction_code?: string
          long_term_benefit?: string | null
          long_term_threshold_days?: number | null
          notes?: string | null
          rebuy_restriction_days?: number | null
          tax_free_after_days?: number | null
          wash_sale_rule?: boolean | null
        }
        Relationships: []
      }
      kv_store_e172c8d9: {
        Row: {
          key: string
          value: Json
        }
        Insert: {
          key: string
          value: Json
        }
        Update: {
          key?: string
          value?: Json
        }
        Relationships: []
      }
      kya_compliance_receipts: {
        Row: {
          agent_name: string
          agent_repid_score: number | null
          agent_repid_tier: string | null
          audit_hash: string | null
          base_sepolia_explorer_url: string | null
          base_sepolia_tx_hash: string | null
          bft_consensus_weight: number | null
          bft_passed: boolean | null
          bft_threshold: number | null
          bft_votes_against: string[] | null
          bft_votes_for: string[] | null
          created_at: string | null
          custodian_context: Json | null
          fireblocks_preauth_id: string | null
          human_custody_bound: boolean | null
          id: number
          insurance_coverage: number | null
          kya_verified: boolean | null
          on_chain_network: string | null
          on_chain_verified: boolean | null
          payment_amount_usdc: number
          pythagorean_veto: boolean | null
          receipt_id: string | null
          recipient_address: string
          rule_hash: string | null
          solana_explorer_url: string | null
          solana_tx_hash: string | null
          tx_verification_status: string | null
          within_daily_limit: boolean | null
          within_tx_limit: boolean | null
          zkp_proof_cid: string | null
        }
        Insert: {
          agent_name: string
          agent_repid_score?: number | null
          agent_repid_tier?: string | null
          audit_hash?: string | null
          base_sepolia_explorer_url?: string | null
          base_sepolia_tx_hash?: string | null
          bft_consensus_weight?: number | null
          bft_passed?: boolean | null
          bft_threshold?: number | null
          bft_votes_against?: string[] | null
          bft_votes_for?: string[] | null
          created_at?: string | null
          custodian_context?: Json | null
          fireblocks_preauth_id?: string | null
          human_custody_bound?: boolean | null
          id?: number
          insurance_coverage?: number | null
          kya_verified?: boolean | null
          on_chain_network?: string | null
          on_chain_verified?: boolean | null
          payment_amount_usdc: number
          pythagorean_veto?: boolean | null
          receipt_id?: string | null
          recipient_address: string
          rule_hash?: string | null
          solana_explorer_url?: string | null
          solana_tx_hash?: string | null
          tx_verification_status?: string | null
          within_daily_limit?: boolean | null
          within_tx_limit?: boolean | null
          zkp_proof_cid?: string | null
        }
        Update: {
          agent_name?: string
          agent_repid_score?: number | null
          agent_repid_tier?: string | null
          audit_hash?: string | null
          base_sepolia_explorer_url?: string | null
          base_sepolia_tx_hash?: string | null
          bft_consensus_weight?: number | null
          bft_passed?: boolean | null
          bft_threshold?: number | null
          bft_votes_against?: string[] | null
          bft_votes_for?: string[] | null
          created_at?: string | null
          custodian_context?: Json | null
          fireblocks_preauth_id?: string | null
          human_custody_bound?: boolean | null
          id?: number
          insurance_coverage?: number | null
          kya_verified?: boolean | null
          on_chain_network?: string | null
          on_chain_verified?: boolean | null
          payment_amount_usdc?: number
          pythagorean_veto?: boolean | null
          receipt_id?: string | null
          recipient_address?: string
          rule_hash?: string | null
          solana_explorer_url?: string | null
          solana_tx_hash?: string | null
          tx_verification_status?: string | null
          within_daily_limit?: boolean | null
          within_tx_limit?: boolean | null
          zkp_proof_cid?: string | null
        }
        Relationships: []
      }
      leads: {
        Row: {
          company: string | null
          created_at: string | null
          ecosystem_app_description: string | null
          email: string
          id: string
          name: string | null
          referral_detail: string | null
          referral_source: string | null
          role: string | null
          updated_at: string | null
          verification_code: string | null
          verification_status: string | null
          verified_at: string | null
          wants_ecosystem_consideration: boolean | null
        }
        Insert: {
          company?: string | null
          created_at?: string | null
          ecosystem_app_description?: string | null
          email: string
          id?: string
          name?: string | null
          referral_detail?: string | null
          referral_source?: string | null
          role?: string | null
          updated_at?: string | null
          verification_code?: string | null
          verification_status?: string | null
          verified_at?: string | null
          wants_ecosystem_consideration?: boolean | null
        }
        Update: {
          company?: string | null
          created_at?: string | null
          ecosystem_app_description?: string | null
          email?: string
          id?: string
          name?: string | null
          referral_detail?: string | null
          referral_source?: string | null
          role?: string | null
          updated_at?: string | null
          verification_code?: string | null
          verification_status?: string | null
          verified_at?: string | null
          wants_ecosystem_consideration?: boolean | null
        }
        Relationships: []
      }
      lessons_learned: {
        Row: {
          applies_to: string[] | null
          created_at: string | null
          created_by: string | null
          id: number
          lesson: string
          lesson_type: string | null
          project_id: number | null
        }
        Insert: {
          applies_to?: string[] | null
          created_at?: string | null
          created_by?: string | null
          id?: number
          lesson: string
          lesson_type?: string | null
          project_id?: number | null
        }
        Update: {
          applies_to?: string[] | null
          created_at?: string | null
          created_by?: string | null
          id?: number
          lesson?: string
          lesson_type?: string | null
          project_id?: number | null
        }
        Relationships: []
      }
      linked_bets: {
        Row: {
          agent_id: string
          authority_snapshot_id: string | null
          bet_amount: number
          claimed_confidence: number
          created_at: string
          expected_resolution_time: string
          id: string
          is_simulated: boolean
          oracle_endpoint: string
          oracle_outcome: boolean | null
          oracle_signature: string | null
          plonky3_proof_bytes: string | null
          prediction_payload: Json
          proof_hex: string | null
          repid_delta_resolved: number | null
          resolved_at: string | null
          status: string
          token_delta_resolved: number | null
        }
        Insert: {
          agent_id: string
          authority_snapshot_id?: string | null
          bet_amount: number
          claimed_confidence: number
          created_at?: string
          expected_resolution_time: string
          id: string
          is_simulated?: boolean
          oracle_endpoint: string
          oracle_outcome?: boolean | null
          oracle_signature?: string | null
          plonky3_proof_bytes?: string | null
          prediction_payload: Json
          proof_hex?: string | null
          repid_delta_resolved?: number | null
          resolved_at?: string | null
          status?: string
          token_delta_resolved?: number | null
        }
        Update: {
          agent_id?: string
          authority_snapshot_id?: string | null
          bet_amount?: number
          claimed_confidence?: number
          created_at?: string
          expected_resolution_time?: string
          id?: string
          is_simulated?: boolean
          oracle_endpoint?: string
          oracle_outcome?: boolean | null
          oracle_signature?: string | null
          plonky3_proof_bytes?: string | null
          prediction_payload?: Json
          proof_hex?: string | null
          repid_delta_resolved?: number | null
          resolved_at?: string | null
          status?: string
          token_delta_resolved?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "linked_bets_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "linked_bets_authority_snapshot_id_fkey"
            columns: ["authority_snapshot_id"]
            isOneToOne: false
            referencedRelation: "stake_authority_snapshots"
            referencedColumns: ["id"]
          },
        ]
      }
      liveness_probe_history: {
        Row: {
          created_at: string
          id: number
          message: string | null
          metrics: Json
          probe_name: string
          run_id: string
          status: string
        }
        Insert: {
          created_at?: string
          id?: number
          message?: string | null
          metrics?: Json
          probe_name: string
          run_id: string
          status: string
        }
        Update: {
          created_at?: string
          id?: number
          message?: string | null
          metrics?: Json
          probe_name?: string
          run_id?: string
          status?: string
        }
        Relationships: []
      }
      llm_call_log: {
        Row: {
          agent_id: string | null
          call_id: string
          completion_tokens: number
          cost_usd: number
          created_at: string
          error_message: string | null
          id: string
          latency_ms: number | null
          model: string
          prompt_tokens: number
          provider: string
          status: string
          task_hint: string | null
          tier: string
          total_tokens: number | null
          user_id: string | null
        }
        Insert: {
          agent_id?: string | null
          call_id: string
          completion_tokens?: number
          cost_usd?: number
          created_at?: string
          error_message?: string | null
          id?: string
          latency_ms?: number | null
          model: string
          prompt_tokens?: number
          provider: string
          status?: string
          task_hint?: string | null
          tier: string
          total_tokens?: number | null
          user_id?: string | null
        }
        Update: {
          agent_id?: string | null
          call_id?: string
          completion_tokens?: number
          cost_usd?: number
          created_at?: string
          error_message?: string | null
          id?: string
          latency_ms?: number | null
          model?: string
          prompt_tokens?: number
          provider?: string
          status?: string
          task_hint?: string | null
          tier?: string
          total_tokens?: number | null
          user_id?: string | null
        }
        Relationships: []
      }
      anfis_routing_logs: {
        Row: {
          id: number
          created_at: string
          prompt_preview: string | null
          category: string | null
          static_provider: string | null
          static_tier: string | null
          static_reason: string | null
          anfis_provider: string | null
          anfis_tier: string | null
          anfis_conf: number | null
          cost_usdc: number | null
          cost_saved: number | null
          latency_ms: number | null
          success: boolean | null
          verified_by: string[] | null
          request_text: string | null
          outcome_hal_score: number | null
          outcome_vetoed: boolean | null
          n_providers: number | null
          notes: Json | null
        }
        Insert: {
          id?: number
          created_at?: string
          prompt_preview?: string | null
          category?: string | null
          static_provider?: string | null
          static_tier?: string | null
          static_reason?: string | null
          anfis_provider?: string | null
          anfis_tier?: string | null
          anfis_conf?: number | null
          cost_usdc?: number | null
          cost_saved?: number | null
          latency_ms?: number | null
          success?: boolean | null
          verified_by?: string[] | null
          request_text?: string | null
          outcome_hal_score?: number | null
          outcome_vetoed?: boolean | null
          n_providers?: number | null
          notes?: Json | null
        }
        Update: {
          id?: number
          created_at?: string
          prompt_preview?: string | null
          category?: string | null
          static_provider?: string | null
          static_tier?: string | null
          static_reason?: string | null
          anfis_provider?: string | null
          anfis_tier?: string | null
          anfis_conf?: number | null
          cost_usdc?: number | null
          cost_saved?: number | null
          latency_ms?: number | null
          success?: boolean | null
          verified_by?: string[] | null
          request_text?: string | null
          outcome_hal_score?: number | null
          outcome_vetoed?: boolean | null
          n_providers?: number | null
          notes?: Json | null
        }
        Relationships: []
      }
      llm_provider_caps: {
        Row: {
          created_at: string
          current_month_spent_usd: number
          hard_disabled: boolean
          id: string
          last_reset_at: string
          monthly_limit_usd: number
          notes: string | null
          provider: string
          tier: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          current_month_spent_usd?: number
          hard_disabled?: boolean
          id?: string
          last_reset_at?: string
          monthly_limit_usd?: number
          notes?: string | null
          provider: string
          tier: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          current_month_spent_usd?: number
          hard_disabled?: boolean
          id?: string
          last_reset_at?: string
          monthly_limit_usd?: number
          notes?: string | null
          provider?: string
          tier?: string
          updated_at?: string
        }
        Relationships: []
      }
      managers: {
        Row: {
          api_key_encrypted: string | null
          id: string
          name: string
          style: string | null
        }
        Insert: {
          api_key_encrypted?: string | null
          id?: string
          name: string
          style?: string | null
        }
        Update: {
          api_key_encrypted?: string | null
          id?: string
          name?: string
          style?: string | null
        }
        Relationships: []
      }
      memory_cold: {
        Row: {
          access_count: number | null
          agent_name: string | null
          brain_region: string | null
          confidence: number | null
          content: string
          created_at: string | null
          demoted_at: string | null
          embedding: string | null
          id: number
          last_accessed: string | null
          memory_type: string | null
          original_warm_id: number | null
          user_id: string | null
        }
        Insert: {
          access_count?: number | null
          agent_name?: string | null
          brain_region?: string | null
          confidence?: number | null
          content: string
          created_at?: string | null
          demoted_at?: string | null
          embedding?: string | null
          id?: number
          last_accessed?: string | null
          memory_type?: string | null
          original_warm_id?: number | null
          user_id?: string | null
        }
        Update: {
          access_count?: number | null
          agent_name?: string | null
          brain_region?: string | null
          confidence?: number | null
          content?: string
          created_at?: string | null
          demoted_at?: string | null
          embedding?: string | null
          id?: number
          last_accessed?: string | null
          memory_type?: string | null
          original_warm_id?: number | null
          user_id?: string | null
        }
        Relationships: []
      }
      memory_deltas: {
        Row: {
          agent_name: string
          created_at: string | null
          id: string
          insight: string
        }
        Insert: {
          agent_name: string
          created_at?: string | null
          id?: string
          insight: string
        }
        Update: {
          agent_name?: string
          created_at?: string | null
          id?: string
          insight?: string
        }
        Relationships: []
      }
      memory_glacier: {
        Row: {
          content_compressed: string | null
          demoted_at: string | null
          id: number
          metadata: Json | null
          original_cold_id: number | null
          user_id: string | null
        }
        Insert: {
          content_compressed?: string | null
          demoted_at?: string | null
          id?: number
          metadata?: Json | null
          original_cold_id?: number | null
          user_id?: string | null
        }
        Update: {
          content_compressed?: string | null
          demoted_at?: string | null
          id?: number
          metadata?: Json | null
          original_cold_id?: number | null
          user_id?: string | null
        }
        Relationships: []
      }
      memory_warm: {
        Row: {
          access_count: number | null
          agent_name: string | null
          brain_region: string | null
          confidence: number | null
          content: string
          created_at: string | null
          embedding: string | null
          id: number
          last_accessed: string | null
          memory_type: string | null
          promoted_from_hot_at: string | null
          source_conversation: string | null
          user_id: string | null
        }
        Insert: {
          access_count?: number | null
          agent_name?: string | null
          brain_region?: string | null
          confidence?: number | null
          content: string
          created_at?: string | null
          embedding?: string | null
          id?: number
          last_accessed?: string | null
          memory_type?: string | null
          promoted_from_hot_at?: string | null
          source_conversation?: string | null
          user_id?: string | null
        }
        Update: {
          access_count?: number | null
          agent_name?: string | null
          brain_region?: string | null
          confidence?: number | null
          content?: string
          created_at?: string | null
          embedding?: string | null
          id?: number
          last_accessed?: string | null
          memory_type?: string | null
          promoted_from_hot_at?: string | null
          source_conversation?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "memory_warm_brain_region_fkey"
            columns: ["brain_region"]
            isOneToOne: false
            referencedRelation: "brain_regions"
            referencedColumns: ["region_name"]
          },
        ]
      }
      merkle_batches: {
        Row: {
          agent_name: string
          batch_end_time: string
          batch_root: string
          batch_start_time: string
          created_at: string | null
          decision_count: number
          decision_ids: number[]
          hyperdag_version: string | null
          id: number
          proof_type: string | null
        }
        Insert: {
          agent_name: string
          batch_end_time: string
          batch_root: string
          batch_start_time: string
          created_at?: string | null
          decision_count: number
          decision_ids: number[]
          hyperdag_version?: string | null
          id?: number
          proof_type?: string | null
        }
        Update: {
          agent_name?: string
          batch_end_time?: string
          batch_root?: string
          batch_start_time?: string
          created_at?: string | null
          decision_count?: number
          decision_ids?: number[]
          hyperdag_version?: string | null
          id?: number
          proof_type?: string | null
        }
        Relationships: []
      }
      mission_cards: {
        Row: {
          assigned_to: string | null
          created_at: string | null
          description: string | null
          id: string
          priority: number | null
          status: string | null
          title: string
        }
        Insert: {
          assigned_to?: string | null
          created_at?: string | null
          description?: string | null
          id?: string
          priority?: number | null
          status?: string | null
          title: string
        }
        Update: {
          assigned_to?: string | null
          created_at?: string | null
          description?: string | null
          id?: string
          priority?: number | null
          status?: string | null
          title?: string
        }
        Relationships: []
      }
      mobile_auth_requests: {
        Row: {
          agent_name: string
          amount_usdc: number | null
          approved: boolean | null
          approved_at: string | null
          device_signature: string | null
          expires_at: string | null
          id: number
          institution_id: string
          payment_id: string
          push_sent_at: string | null
          request_id: string | null
          signer_sbt_token_id: string | null
          status: string | null
        }
        Insert: {
          agent_name: string
          amount_usdc?: number | null
          approved?: boolean | null
          approved_at?: string | null
          device_signature?: string | null
          expires_at?: string | null
          id?: number
          institution_id: string
          payment_id: string
          push_sent_at?: string | null
          request_id?: string | null
          signer_sbt_token_id?: string | null
          status?: string | null
        }
        Update: {
          agent_name?: string
          amount_usdc?: number | null
          approved?: boolean | null
          approved_at?: string | null
          device_signature?: string | null
          expires_at?: string | null
          id?: number
          institution_id?: string
          payment_id?: string
          push_sent_at?: string | null
          request_id?: string | null
          signer_sbt_token_id?: string | null
          status?: string | null
        }
        Relationships: []
      }
      moderation_queue: {
        Row: {
          content_id: number
          content_type: string
          created_at: string | null
          id: number
          priority: number | null
          reason: string
          review_notes: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string | null
        }
        Insert: {
          content_id: number
          content_type: string
          created_at?: string | null
          id?: number
          priority?: number | null
          reason: string
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string | null
        }
        Update: {
          content_id?: number
          content_type?: string
          created_at?: string | null
          id?: number
          priority?: number | null
          reason?: string
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string | null
        }
        Relationships: []
      }
      musing_templates: {
        Row: {
          active: boolean
          category: string
          created_at: string
          description: string | null
          id: string
          template_text: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          category: string
          created_at?: string
          description?: string | null
          id?: string
          template_text: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          category?: string
          created_at?: string
          description?: string | null
          id?: string
          template_text?: string
          updated_at?: string
        }
        Relationships: []
      }
      notifications: {
        Row: {
          created_at: string
          data: Json | null
          id: string
          message: string
          read: boolean | null
          title: string
          type: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          data?: Json | null
          id?: string
          message: string
          read?: boolean | null
          title: string
          type: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          data?: Json | null
          id?: string
          message?: string
          read?: boolean | null
          title?: string
          type?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      opportunities: {
        Row: {
          created_at: string | null
          deadline: string | null
          discovered_by: string | null
          fit_score: number | null
          id: string
          opportunity_type: string
          prize_amount: number | null
          status: string | null
          title: string
        }
        Insert: {
          created_at?: string | null
          deadline?: string | null
          discovered_by?: string | null
          fit_score?: number | null
          id?: string
          opportunity_type: string
          prize_amount?: number | null
          status?: string | null
          title: string
        }
        Update: {
          created_at?: string | null
          deadline?: string | null
          discovered_by?: string | null
          fit_score?: number | null
          id?: string
          opportunity_type?: string
          prize_amount?: number | null
          status?: string | null
          title?: string
        }
        Relationships: []
      }
      orchestrator_cycles: {
        Row: {
          completed_at: string | null
          cycle_number: number | null
          end_time: string | null
          id: string
          incoming_orchestrator_id: string | null
          learned_insights: Json | null
          outgoing_orchestrator_id: string | null
          peer_ratings: Json | null
          start_time: string | null
        }
        Insert: {
          completed_at?: string | null
          cycle_number?: number | null
          end_time?: string | null
          id?: string
          incoming_orchestrator_id?: string | null
          learned_insights?: Json | null
          outgoing_orchestrator_id?: string | null
          peer_ratings?: Json | null
          start_time?: string | null
        }
        Update: {
          completed_at?: string | null
          cycle_number?: number | null
          end_time?: string | null
          id?: string
          incoming_orchestrator_id?: string | null
          learned_insights?: Json | null
          outgoing_orchestrator_id?: string | null
          peer_ratings?: Json | null
          start_time?: string | null
        }
        Relationships: []
      }
      paper_trade_orders: {
        Row: {
          agent_id: string
          alpaca_order_id: string | null
          bet_id: string
          builder_id: string
          cap_pct_at_open: number | null
          created_at: string
          filled_avg_price: number | null
          filled_qty: number | null
          id: string
          limit_price: number | null
          notional_estimate: number | null
          pnl: number | null
          provider: string
          qty: number
          resolved_at: string | null
          side: string
          status: string
          symbol: string
          type: string
        }
        Insert: {
          agent_id: string
          alpaca_order_id?: string | null
          bet_id: string
          builder_id: string
          cap_pct_at_open?: number | null
          created_at?: string
          filled_avg_price?: number | null
          filled_qty?: number | null
          id?: string
          limit_price?: number | null
          notional_estimate?: number | null
          pnl?: number | null
          provider: string
          qty: number
          resolved_at?: string | null
          side: string
          status?: string
          symbol: string
          type?: string
        }
        Update: {
          agent_id?: string
          alpaca_order_id?: string | null
          bet_id?: string
          builder_id?: string
          cap_pct_at_open?: number | null
          created_at?: string
          filled_avg_price?: number | null
          filled_qty?: number | null
          id?: string
          limit_price?: number | null
          notional_estimate?: number | null
          pnl?: number | null
          provider?: string
          qty?: number
          resolved_at?: string | null
          side?: string
          status?: string
          symbol?: string
          type?: string
        }
        Relationships: []
      }
      paper_trades: {
        Row: {
          action: string
          amount_usd: number
          closed_at: string | null
          id: number
          opened_at: string | null
          pair: string
          pnl_usd: number | null
          price_at_entry: number
          price_at_exit: number | null
          signal_id: number | null
          status: string | null
          user_email: string
        }
        Insert: {
          action: string
          amount_usd: number
          closed_at?: string | null
          id?: number
          opened_at?: string | null
          pair: string
          pnl_usd?: number | null
          price_at_entry: number
          price_at_exit?: number | null
          signal_id?: number | null
          status?: string | null
          user_email: string
        }
        Update: {
          action?: string
          amount_usd?: number
          closed_at?: string | null
          id?: number
          opened_at?: string | null
          pair?: string
          pnl_usd?: number | null
          price_at_entry?: number
          price_at_exit?: number | null
          signal_id?: number | null
          status?: string | null
          user_email?: string
        }
        Relationships: [
          {
            foreignKeyName: "paper_trades_signal_id_fkey"
            columns: ["signal_id"]
            isOneToOne: false
            referencedRelation: "hal_signals"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_log: {
        Row: {
          agent_id: string
          amount_usdc: number
          autonomy_tier: string
          chain: string
          counterparty: string
          created_at: string | null
          delegation_chain: Json | null
          id: number
          payment_proof_hash: string | null
          repid_at_time: number
          reputation_weight: number | null
          status: string
          tx_hash: string | null
          veto_tier: string | null
        }
        Insert: {
          agent_id: string
          amount_usdc: number
          autonomy_tier: string
          chain?: string
          counterparty: string
          created_at?: string | null
          delegation_chain?: Json | null
          id?: number
          payment_proof_hash?: string | null
          repid_at_time: number
          reputation_weight?: number | null
          status?: string
          tx_hash?: string | null
          veto_tier?: string | null
        }
        Update: {
          agent_id?: string
          amount_usdc?: number
          autonomy_tier?: string
          chain?: string
          counterparty?: string
          created_at?: string | null
          delegation_chain?: Json | null
          id?: number
          payment_proof_hash?: string | null
          repid_at_time?: number
          reputation_weight?: number | null
          status?: string
          tx_hash?: string | null
          veto_tier?: string | null
        }
        Relationships: []
      }
      peer_lessons: {
        Row: {
          confidence_delta: number | null
          cycle_id: string | null
          evidence_pattern: Json | null
          expires_at: string | null
          id: number
          learned_at: string | null
          learning_agent: string
          lesson_type: string
          lesson_validated: boolean | null
          modality: string
          regime_context: string | null
          source_orthogonal: boolean | null
          teaching_agent: string
        }
        Insert: {
          confidence_delta?: number | null
          cycle_id?: string | null
          evidence_pattern?: Json | null
          expires_at?: string | null
          id?: number
          learned_at?: string | null
          learning_agent: string
          lesson_type: string
          lesson_validated?: boolean | null
          modality: string
          regime_context?: string | null
          source_orthogonal?: boolean | null
          teaching_agent: string
        }
        Update: {
          confidence_delta?: number | null
          cycle_id?: string | null
          evidence_pattern?: Json | null
          expires_at?: string | null
          id?: number
          learned_at?: string | null
          learning_agent?: string
          lesson_type?: string
          lesson_validated?: boolean | null
          modality?: string
          regime_context?: string | null
          source_orthogonal?: boolean | null
          teaching_agent?: string
        }
        Relationships: [
          {
            foreignKeyName: "peer_lessons_cycle_id_fkey"
            columns: ["cycle_id"]
            isOneToOne: false
            referencedRelation: "prediction_consensus"
            referencedColumns: ["cycle_id"]
          },
        ]
      }
      pending_actions: {
        Row: {
          action_type: string
          created_at: string | null
          description: string
          estimated_cost: number | null
          id: string
          status: string | null
        }
        Insert: {
          action_type: string
          created_at?: string | null
          description: string
          estimated_cost?: number | null
          id?: string
          status?: string | null
        }
        Update: {
          action_type?: string
          created_at?: string | null
          description?: string
          estimated_cost?: number | null
          id?: string
          status?: string | null
        }
        Relationships: []
      }
      pending_authorizations: {
        Row: {
          action_details: Json
          action_type: string
          amount_usdc: number | null
          authorization_id: string | null
          created_at: string | null
          expires_at: string | null
          id: number
          institution_id: string
          requested_by: string
          resolved_at: string | null
          sig1_approved: boolean | null
          sig1_role: string | null
          sig1_sbt_token_id: string | null
          sig1_signer: string | null
          sig1_timestamp: string | null
          sig1_zkp_proof_cid: string | null
          sig2_approved: boolean | null
          sig2_role: string | null
          sig2_sbt_token_id: string | null
          sig2_signer: string | null
          sig2_timestamp: string | null
          sig2_zkp_proof_cid: string | null
          status: string | null
        }
        Insert: {
          action_details?: Json
          action_type: string
          amount_usdc?: number | null
          authorization_id?: string | null
          created_at?: string | null
          expires_at?: string | null
          id?: number
          institution_id?: string
          requested_by: string
          resolved_at?: string | null
          sig1_approved?: boolean | null
          sig1_role?: string | null
          sig1_sbt_token_id?: string | null
          sig1_signer?: string | null
          sig1_timestamp?: string | null
          sig1_zkp_proof_cid?: string | null
          sig2_approved?: boolean | null
          sig2_role?: string | null
          sig2_sbt_token_id?: string | null
          sig2_signer?: string | null
          sig2_timestamp?: string | null
          sig2_zkp_proof_cid?: string | null
          status?: string | null
        }
        Update: {
          action_details?: Json
          action_type?: string
          amount_usdc?: number | null
          authorization_id?: string | null
          created_at?: string | null
          expires_at?: string | null
          id?: number
          institution_id?: string
          requested_by?: string
          resolved_at?: string | null
          sig1_approved?: boolean | null
          sig1_role?: string | null
          sig1_sbt_token_id?: string | null
          sig1_signer?: string | null
          sig1_timestamp?: string | null
          sig1_zkp_proof_cid?: string | null
          sig2_approved?: boolean | null
          sig2_role?: string | null
          sig2_sbt_token_id?: string | null
          sig2_signer?: string | null
          sig2_timestamp?: string | null
          sig2_zkp_proof_cid?: string | null
          status?: string | null
        }
        Relationships: []
      }
      perceived_repid_assessments: {
        Row: {
          assessment_reason: string | null
          assessment_weight: number | null
          assessor_earned_score: number
          assessor_identity: string
          created_at: string | null
          evidence_hash: string | null
          expires_at: string | null
          id: string
          perceived_score_given: number
          target_agent: string
        }
        Insert: {
          assessment_reason?: string | null
          assessment_weight?: number | null
          assessor_earned_score?: number
          assessor_identity: string
          created_at?: string | null
          evidence_hash?: string | null
          expires_at?: string | null
          id?: string
          perceived_score_given: number
          target_agent: string
        }
        Update: {
          assessment_reason?: string | null
          assessment_weight?: number | null
          assessor_earned_score?: number
          assessor_identity?: string
          created_at?: string | null
          evidence_hash?: string | null
          expires_at?: string | null
          id?: string
          perceived_score_given?: number
          target_agent?: string
        }
        Relationships: []
      }
      permissioned_vaults: {
        Row: {
          active: boolean | null
          created_at: string | null
          fireblocks_policy_id: string | null
          id: number
          max_withdrawal_usdc: number | null
          min_repid_required: number | null
          min_tier_required: string | null
          owner_id: string
          requires_bft_consensus: boolean | null
          requires_human_custody: boolean | null
          total_balance_usdc: number | null
          vault_id: string | null
          vault_name: string
        }
        Insert: {
          active?: boolean | null
          created_at?: string | null
          fireblocks_policy_id?: string | null
          id?: number
          max_withdrawal_usdc?: number | null
          min_repid_required?: number | null
          min_tier_required?: string | null
          owner_id?: string
          requires_bft_consensus?: boolean | null
          requires_human_custody?: boolean | null
          total_balance_usdc?: number | null
          vault_id?: string | null
          vault_name: string
        }
        Update: {
          active?: boolean | null
          created_at?: string | null
          fireblocks_policy_id?: string | null
          id?: number
          max_withdrawal_usdc?: number | null
          min_repid_required?: number | null
          min_tier_required?: string | null
          owner_id?: string
          requires_bft_consensus?: boolean | null
          requires_human_custody?: boolean | null
          total_balance_usdc?: number | null
          vault_id?: string | null
          vault_name?: string
        }
        Relationships: []
      }
      personal_truth_facts: {
        Row: {
          confidence: number | null
          created_at: string | null
          embedding: string | null
          entity_key: string
          id: string
          source: string | null
          updated_at: string | null
          user_or_agent_id: string
          value: string
        }
        Insert: {
          confidence?: number | null
          created_at?: string | null
          embedding?: string | null
          entity_key: string
          id?: string
          source?: string | null
          updated_at?: string | null
          user_or_agent_id: string
          value: string
        }
        Update: {
          confidence?: number | null
          created_at?: string | null
          embedding?: string | null
          entity_key?: string
          id?: string
          source?: string | null
          updated_at?: string | null
          user_or_agent_id?: string
          value?: string
        }
        Relationships: []
      }
      pipeline_templates: {
        Row: {
          id: number
          name: string | null
          stages: Json | null
        }
        Insert: {
          id?: number
          name?: string | null
          stages?: Json | null
        }
        Update: {
          id?: number
          name?: string | null
          stages?: Json | null
        }
        Relationships: []
      }
      planted_error_events: {
        Row: {
          apprentice_agent_id: string | null
          apprentice_repid_delta: number | null
          apprentice_response: string | null
          correct_response: string | null
          created_at: string | null
          decision_id: number | null
          difficulty_tier: string | null
          error_type: string | null
          id: number
          planter_repid_delta: number | null
          planting_agent_id: string | null
          resolved_at: string | null
          squad_id: string | null
          was_caught: boolean | null
        }
        Insert: {
          apprentice_agent_id?: string | null
          apprentice_repid_delta?: number | null
          apprentice_response?: string | null
          correct_response?: string | null
          created_at?: string | null
          decision_id?: number | null
          difficulty_tier?: string | null
          error_type?: string | null
          id?: number
          planter_repid_delta?: number | null
          planting_agent_id?: string | null
          resolved_at?: string | null
          squad_id?: string | null
          was_caught?: boolean | null
        }
        Update: {
          apprentice_agent_id?: string | null
          apprentice_repid_delta?: number | null
          apprentice_response?: string | null
          correct_response?: string | null
          created_at?: string | null
          decision_id?: number | null
          difficulty_tier?: string | null
          error_type?: string | null
          id?: number
          planter_repid_delta?: number | null
          planting_agent_id?: string | null
          resolved_at?: string | null
          squad_id?: string | null
          was_caught?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "planted_error_events_apprentice_agent_id_fkey"
            columns: ["apprentice_agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "planted_error_events_planting_agent_id_fkey"
            columns: ["planting_agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_heartbeats: {
        Row: {
          agent_name: string
          completed_at: string | null
          duration_seconds: number | null
          id: number
          notes: string | null
          platform: string
          started_at: string | null
          success: boolean | null
          task_id: number | null
          task_title: string | null
          timestamp: string | null
        }
        Insert: {
          agent_name: string
          completed_at?: string | null
          duration_seconds?: number | null
          id?: number
          notes?: string | null
          platform: string
          started_at?: string | null
          success?: boolean | null
          task_id?: number | null
          task_title?: string | null
          timestamp?: string | null
        }
        Update: {
          agent_name?: string
          completed_at?: string | null
          duration_seconds?: number | null
          id?: number
          notes?: string | null
          platform?: string
          started_at?: string | null
          success?: boolean | null
          task_id?: number | null
          task_title?: string | null
          timestamp?: string | null
        }
        Relationships: []
      }
      pol_otp_sessions: {
        Row: {
          created_at: string | null
          dbt_token_id: string
          destination_hash: string
          expires_at: string
          id: number
          otp_hash: string
          otp_type: string
          used_at: string | null
          verified: boolean | null
        }
        Insert: {
          created_at?: string | null
          dbt_token_id: string
          destination_hash: string
          expires_at?: string
          id?: number
          otp_hash: string
          otp_type: string
          used_at?: string | null
          verified?: boolean | null
        }
        Update: {
          created_at?: string | null
          dbt_token_id?: string
          destination_hash?: string
          expires_at?: string
          id?: number
          otp_hash?: string
          otp_type?: string
          used_at?: string | null
          verified?: boolean | null
        }
        Relationships: []
      }
      prediction_consensus: {
        Row: {
          asset: string
          bft_dissenting_agents: Json | null
          bft_threshold_met: boolean | null
          bft_vote_count: number | null
          bft_votes: Json | null
          cascade_direction: string | null
          comma_auto_triggered: boolean | null
          comma_gap_units: number | null
          comma_reason: string | null
          comma_severity: string | null
          cycle_completed_at: string | null
          cycle_id: string
          cycle_started_at: string
          final_confidence: number | null
          final_signal: string | null
          hitl_completed_at: string | null
          hitl_decision: string | null
          hitl_required: boolean | null
          mel_density_matrix: Json | null
          mel_ensemble_confidence: number | null
          mel_ensemble_direction: string | null
          mfdfa_echo_confirmed: boolean | null
          portfolio_assignment: string | null
          position_size_multiplier: number | null
          regime_id: number | null
          reverse_cascade_detected: boolean | null
          rqa_escalation_applied: boolean | null
          shofet_confidence: number | null
          shofet_reasoning: string | null
          shofet_ruling: string | null
          target_price_1h: number | null
          target_price_24h: number | null
          target_price_4h: number | null
        }
        Insert: {
          asset: string
          bft_dissenting_agents?: Json | null
          bft_threshold_met?: boolean | null
          bft_vote_count?: number | null
          bft_votes?: Json | null
          cascade_direction?: string | null
          comma_auto_triggered?: boolean | null
          comma_gap_units?: number | null
          comma_reason?: string | null
          comma_severity?: string | null
          cycle_completed_at?: string | null
          cycle_id?: string
          cycle_started_at?: string
          final_confidence?: number | null
          final_signal?: string | null
          hitl_completed_at?: string | null
          hitl_decision?: string | null
          hitl_required?: boolean | null
          mel_density_matrix?: Json | null
          mel_ensemble_confidence?: number | null
          mel_ensemble_direction?: string | null
          mfdfa_echo_confirmed?: boolean | null
          portfolio_assignment?: string | null
          position_size_multiplier?: number | null
          regime_id?: number | null
          reverse_cascade_detected?: boolean | null
          rqa_escalation_applied?: boolean | null
          shofet_confidence?: number | null
          shofet_reasoning?: string | null
          shofet_ruling?: string | null
          target_price_1h?: number | null
          target_price_24h?: number | null
          target_price_4h?: number | null
        }
        Update: {
          asset?: string
          bft_dissenting_agents?: Json | null
          bft_threshold_met?: boolean | null
          bft_vote_count?: number | null
          bft_votes?: Json | null
          cascade_direction?: string | null
          comma_auto_triggered?: boolean | null
          comma_gap_units?: number | null
          comma_reason?: string | null
          comma_severity?: string | null
          cycle_completed_at?: string | null
          cycle_id?: string
          cycle_started_at?: string
          final_confidence?: number | null
          final_signal?: string | null
          hitl_completed_at?: string | null
          hitl_decision?: string | null
          hitl_required?: boolean | null
          mel_density_matrix?: Json | null
          mel_ensemble_confidence?: number | null
          mel_ensemble_direction?: string | null
          mfdfa_echo_confirmed?: boolean | null
          portfolio_assignment?: string | null
          position_size_multiplier?: number | null
          regime_id?: number | null
          reverse_cascade_detected?: boolean | null
          rqa_escalation_applied?: boolean | null
          shofet_confidence?: number | null
          shofet_reasoning?: string | null
          shofet_ruling?: string | null
          target_price_1h?: number | null
          target_price_24h?: number | null
          target_price_4h?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "prediction_consensus_regime_id_fkey"
            columns: ["regime_id"]
            isOneToOne: false
            referencedRelation: "prediction_regimes"
            referencedColumns: ["id"]
          },
        ]
      }
      prediction_outcomes: {
        Row: {
          actual_direction_1h: string | null
          actual_direction_24h: string | null
          actual_direction_4h: string | null
          actual_price_1h: number | null
          actual_price_24h: number | null
          actual_price_4h: number | null
          actual_slippage_pct: number | null
          asset: string
          cascade_direction_correct: boolean | null
          comma_severity_at_signal: string | null
          comma_veto_justified: boolean | null
          composite_score: number | null
          cycle_id: string | null
          directional_accuracy: number | null
          directional_correct_1h: boolean | null
          directional_correct_24h: boolean | null
          directional_correct_4h: boolean | null
          id: number
          outcome_recorded_at: string
          predicted_direction: string | null
          predicted_price_1h: number | null
          predicted_price_24h: number | null
          predicted_price_4h: number | null
          predicted_slippage_pct: number | null
          price_range_hit_1h: boolean | null
          price_range_hit_24h: boolean | null
          price_range_hit_4h: boolean | null
          reverse_cascade_confirmed: boolean | null
          sharpe_contribution: number | null
          w3c_upgrade_triggered: boolean | null
        }
        Insert: {
          actual_direction_1h?: string | null
          actual_direction_24h?: string | null
          actual_direction_4h?: string | null
          actual_price_1h?: number | null
          actual_price_24h?: number | null
          actual_price_4h?: number | null
          actual_slippage_pct?: number | null
          asset: string
          cascade_direction_correct?: boolean | null
          comma_severity_at_signal?: string | null
          comma_veto_justified?: boolean | null
          composite_score?: number | null
          cycle_id?: string | null
          directional_accuracy?: number | null
          directional_correct_1h?: boolean | null
          directional_correct_24h?: boolean | null
          directional_correct_4h?: boolean | null
          id?: number
          outcome_recorded_at?: string
          predicted_direction?: string | null
          predicted_price_1h?: number | null
          predicted_price_24h?: number | null
          predicted_price_4h?: number | null
          predicted_slippage_pct?: number | null
          price_range_hit_1h?: boolean | null
          price_range_hit_24h?: boolean | null
          price_range_hit_4h?: boolean | null
          reverse_cascade_confirmed?: boolean | null
          sharpe_contribution?: number | null
          w3c_upgrade_triggered?: boolean | null
        }
        Update: {
          actual_direction_1h?: string | null
          actual_direction_24h?: string | null
          actual_direction_4h?: string | null
          actual_price_1h?: number | null
          actual_price_24h?: number | null
          actual_price_4h?: number | null
          actual_slippage_pct?: number | null
          asset?: string
          cascade_direction_correct?: boolean | null
          comma_severity_at_signal?: string | null
          comma_veto_justified?: boolean | null
          composite_score?: number | null
          cycle_id?: string | null
          directional_accuracy?: number | null
          directional_correct_1h?: boolean | null
          directional_correct_24h?: boolean | null
          directional_correct_4h?: boolean | null
          id?: number
          outcome_recorded_at?: string
          predicted_direction?: string | null
          predicted_price_1h?: number | null
          predicted_price_24h?: number | null
          predicted_price_4h?: number | null
          predicted_slippage_pct?: number | null
          price_range_hit_1h?: boolean | null
          price_range_hit_24h?: boolean | null
          price_range_hit_4h?: boolean | null
          reverse_cascade_confirmed?: boolean | null
          sharpe_contribution?: number | null
          w3c_upgrade_triggered?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "prediction_outcomes_cycle_id_fkey"
            columns: ["cycle_id"]
            isOneToOne: false
            referencedRelation: "prediction_consensus"
            referencedColumns: ["cycle_id"]
          },
        ]
      }
      prediction_postmortems: {
        Row: {
          anfis_updates_triggered: Json | null
          cascade_direction_lesson: string | null
          cycle_id: string | null
          decisive_features: Json | null
          human_pattern_tag: string | null
          human_postmortem_notes: string | null
          id: number
          lesson_embedding: string | null
          lesson_summary: string | null
          losing_agents: Json | null
          missed_signals: Json | null
          postmortem_at: string
          reverse_cascade_lesson: string | null
          similar_cycle_ids: Json | null
          winning_agents: Json | null
          wisdom_activations: Json | null
        }
        Insert: {
          anfis_updates_triggered?: Json | null
          cascade_direction_lesson?: string | null
          cycle_id?: string | null
          decisive_features?: Json | null
          human_pattern_tag?: string | null
          human_postmortem_notes?: string | null
          id?: number
          lesson_embedding?: string | null
          lesson_summary?: string | null
          losing_agents?: Json | null
          missed_signals?: Json | null
          postmortem_at?: string
          reverse_cascade_lesson?: string | null
          similar_cycle_ids?: Json | null
          winning_agents?: Json | null
          wisdom_activations?: Json | null
        }
        Update: {
          anfis_updates_triggered?: Json | null
          cascade_direction_lesson?: string | null
          cycle_id?: string | null
          decisive_features?: Json | null
          human_pattern_tag?: string | null
          human_postmortem_notes?: string | null
          id?: number
          lesson_embedding?: string | null
          lesson_summary?: string | null
          losing_agents?: Json | null
          missed_signals?: Json | null
          postmortem_at?: string
          reverse_cascade_lesson?: string | null
          similar_cycle_ids?: Json | null
          winning_agents?: Json | null
          wisdom_activations?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "prediction_postmortems_cycle_id_fkey"
            columns: ["cycle_id"]
            isOneToOne: false
            referencedRelation: "prediction_consensus"
            referencedColumns: ["cycle_id"]
          },
        ]
      }
      prediction_regimes: {
        Row: {
          cascade_direction: string | null
          chaos_fractal_score: number | null
          detected_at: string
          harmonic_alignment: string | null
          hurst_long: number | null
          hurst_short: number | null
          id: number
          is_reverse_cascade: boolean | null
          lle_value: number | null
          lnn_state: Json | null
          multifractal_width: number | null
          notes: string | null
          recurrence_entropy: number | null
          regime_confidence: number
          regime_type: string
          sophia_agent_version: string | null
        }
        Insert: {
          cascade_direction?: string | null
          chaos_fractal_score?: number | null
          detected_at?: string
          harmonic_alignment?: string | null
          hurst_long?: number | null
          hurst_short?: number | null
          id?: number
          is_reverse_cascade?: boolean | null
          lle_value?: number | null
          lnn_state?: Json | null
          multifractal_width?: number | null
          notes?: string | null
          recurrence_entropy?: number | null
          regime_confidence: number
          regime_type: string
          sophia_agent_version?: string | null
        }
        Update: {
          cascade_direction?: string | null
          chaos_fractal_score?: number | null
          detected_at?: string
          harmonic_alignment?: string | null
          hurst_long?: number | null
          hurst_short?: number | null
          id?: number
          is_reverse_cascade?: boolean | null
          lle_value?: number | null
          lnn_state?: Json | null
          multifractal_width?: number | null
          notes?: string | null
          recurrence_entropy?: number | null
          regime_confidence?: number
          regime_type?: string
          sophia_agent_version?: string | null
        }
        Relationships: []
      }
      prediction_signals: {
        Row: {
          agent_id: string
          asset: string
          capability_score_used: number | null
          comma_delta: number | null
          confidence_1h: number | null
          confidence_24h: number | null
          confidence_4h: number | null
          contradicting_evidence: Json | null
          cycle_id: string
          detected_at: string
          evidence_chain: Json | null
          hallucination_risk: string | null
          id: number
          modality: string | null
          regime_id: number | null
          role_type: string | null
          signal_confidence: number | null
          signal_direction: string | null
          source_list: Json | null
          wisdom_keys_activated: Json | null
        }
        Insert: {
          agent_id: string
          asset: string
          capability_score_used?: number | null
          comma_delta?: number | null
          confidence_1h?: number | null
          confidence_24h?: number | null
          confidence_4h?: number | null
          contradicting_evidence?: Json | null
          cycle_id: string
          detected_at?: string
          evidence_chain?: Json | null
          hallucination_risk?: string | null
          id?: number
          modality?: string | null
          regime_id?: number | null
          role_type?: string | null
          signal_confidence?: number | null
          signal_direction?: string | null
          source_list?: Json | null
          wisdom_keys_activated?: Json | null
        }
        Update: {
          agent_id?: string
          asset?: string
          capability_score_used?: number | null
          comma_delta?: number | null
          confidence_1h?: number | null
          confidence_24h?: number | null
          confidence_4h?: number | null
          contradicting_evidence?: Json | null
          cycle_id?: string
          detected_at?: string
          evidence_chain?: Json | null
          hallucination_risk?: string | null
          id?: number
          modality?: string | null
          regime_id?: number | null
          role_type?: string | null
          signal_confidence?: number | null
          signal_direction?: string | null
          source_list?: Json | null
          wisdom_keys_activated?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "prediction_signals_regime_id_fkey"
            columns: ["regime_id"]
            isOneToOne: false
            referencedRelation: "prediction_regimes"
            referencedColumns: ["id"]
          },
        ]
      }
      priority_stack: {
        Row: {
          blocked_by: string | null
          deadline: string | null
          next_action: string
          owner: string
          project: string
          slot: string
          stage: string
          status: string
          title: string
          updated_at: string | null
          updated_by: string | null
          why_now: string
        }
        Insert: {
          blocked_by?: string | null
          deadline?: string | null
          next_action: string
          owner: string
          project: string
          slot: string
          stage?: string
          status?: string
          title: string
          updated_at?: string | null
          updated_by?: string | null
          why_now: string
        }
        Update: {
          blocked_by?: string | null
          deadline?: string | null
          next_action?: string
          owner?: string
          project?: string
          slot?: string
          stage?: string
          status?: string
          title?: string
          updated_at?: string | null
          updated_by?: string | null
          why_now?: string
        }
        Relationships: []
      }
      product_bmc: {
        Row: {
          bmc_complete: boolean | null
          channels: string | null
          churn_pct: number | null
          cost_structure: string | null
          created_at: string | null
          current_blocker: string | null
          customer_relationships: string | null
          customer_segments: string | null
          deadline: string | null
          disappointment_pct: number | null
          github_url: string | null
          id: string
          key_activities: string | null
          key_partners: string | null
          key_resources: string | null
          landing_page_url: string | null
          lead_magnet: string | null
          live_url: string | null
          ltv_cac_ratio: number | null
          mvp_complete: boolean | null
          next_action: string | null
          notes: string | null
          owner: string | null
          pmf_signals_confirmed: boolean | null
          poc_complete: boolean | null
          priority_slot: string | null
          product_name: string
          retention_pct: number | null
          revenue_streams: string | null
          riskiest_assumption: string | null
          social_posts_drafted: boolean | null
          stage: string
          tagline: string | null
          updated_at: string | null
          user_stories: string | null
          validation_method: string | null
          validation_result: string | null
          value_proposition: string | null
          waitlist_count: number | null
        }
        Insert: {
          bmc_complete?: boolean | null
          channels?: string | null
          churn_pct?: number | null
          cost_structure?: string | null
          created_at?: string | null
          current_blocker?: string | null
          customer_relationships?: string | null
          customer_segments?: string | null
          deadline?: string | null
          disappointment_pct?: number | null
          github_url?: string | null
          id?: string
          key_activities?: string | null
          key_partners?: string | null
          key_resources?: string | null
          landing_page_url?: string | null
          lead_magnet?: string | null
          live_url?: string | null
          ltv_cac_ratio?: number | null
          mvp_complete?: boolean | null
          next_action?: string | null
          notes?: string | null
          owner?: string | null
          pmf_signals_confirmed?: boolean | null
          poc_complete?: boolean | null
          priority_slot?: string | null
          product_name: string
          retention_pct?: number | null
          revenue_streams?: string | null
          riskiest_assumption?: string | null
          social_posts_drafted?: boolean | null
          stage?: string
          tagline?: string | null
          updated_at?: string | null
          user_stories?: string | null
          validation_method?: string | null
          validation_result?: string | null
          value_proposition?: string | null
          waitlist_count?: number | null
        }
        Update: {
          bmc_complete?: boolean | null
          channels?: string | null
          churn_pct?: number | null
          cost_structure?: string | null
          created_at?: string | null
          current_blocker?: string | null
          customer_relationships?: string | null
          customer_segments?: string | null
          deadline?: string | null
          disappointment_pct?: number | null
          github_url?: string | null
          id?: string
          key_activities?: string | null
          key_partners?: string | null
          key_resources?: string | null
          landing_page_url?: string | null
          lead_magnet?: string | null
          live_url?: string | null
          ltv_cac_ratio?: number | null
          mvp_complete?: boolean | null
          next_action?: string | null
          notes?: string | null
          owner?: string | null
          pmf_signals_confirmed?: boolean | null
          poc_complete?: boolean | null
          priority_slot?: string | null
          product_name?: string
          retention_pct?: number | null
          revenue_streams?: string | null
          riskiest_assumption?: string | null
          social_posts_drafted?: boolean | null
          stage?: string
          tagline?: string | null
          updated_at?: string | null
          user_stories?: string | null
          validation_method?: string | null
          validation_result?: string | null
          value_proposition?: string | null
          waitlist_count?: number | null
        }
        Relationships: []
      }
      product_metrics: {
        Row: {
          captured_at: string | null
          date: string | null
          id: number
          project_id: number | null
          revenue_cents: number | null
          sean_ellis_score: number | null
          users_daily: number | null
          users_total: number | null
          users_weekly: number | null
        }
        Insert: {
          captured_at?: string | null
          date?: string | null
          id?: number
          project_id?: number | null
          revenue_cents?: number | null
          sean_ellis_score?: number | null
          users_daily?: number | null
          users_total?: number | null
          users_weekly?: number | null
        }
        Update: {
          captured_at?: string | null
          date?: string | null
          id?: number
          project_id?: number | null
          revenue_cents?: number | null
          sean_ellis_score?: number | null
          users_daily?: number | null
          users_total?: number | null
          users_weekly?: number | null
        }
        Relationships: []
      }
      product_strategy: {
        Row: {
          category: string
          content: string
          created_at: string | null
          id: number
          priority: number | null
          tags: string[] | null
          title: string
          updated_at: string | null
        }
        Insert: {
          category: string
          content: string
          created_at?: string | null
          id?: never
          priority?: number | null
          tags?: string[] | null
          title: string
          updated_at?: string | null
        }
        Update: {
          category?: string
          content?: string
          created_at?: string | null
          id?: never
          priority?: number | null
          tags?: string[] | null
          title?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      productivity_ledger: {
        Row: {
          build_tasks: number | null
          conductor_id: string
          created_at: string | null
          deploy_tasks: number | null
          external_artifacts_created: number | null
          id: number
          is_productive: boolean | null
          ratio_score: number | null
          research_tasks: number | null
          tasks_completed: number | null
          validate_tasks: number | null
          window_end: string
          window_start: string
        }
        Insert: {
          build_tasks?: number | null
          conductor_id: string
          created_at?: string | null
          deploy_tasks?: number | null
          external_artifacts_created?: number | null
          id?: number
          is_productive?: boolean | null
          ratio_score?: number | null
          research_tasks?: number | null
          tasks_completed?: number | null
          validate_tasks?: number | null
          window_end: string
          window_start: string
        }
        Update: {
          build_tasks?: number | null
          conductor_id?: string
          created_at?: string | null
          deploy_tasks?: number | null
          external_artifacts_created?: number | null
          id?: number
          is_productive?: boolean | null
          ratio_score?: number | null
          research_tasks?: number | null
          tasks_completed?: number | null
          validate_tasks?: number | null
          window_end?: string
          window_start?: string
        }
        Relationships: []
      }
      progressive_questions: {
        Row: {
          answer: Json | null
          answered_at: string | null
          asked_at: string
          context: string | null
          id: string
          question_text: string
          question_type: string
          user_id: string
        }
        Insert: {
          answer?: Json | null
          answered_at?: string | null
          asked_at?: string
          context?: string | null
          id?: string
          question_text: string
          question_type: string
          user_id: string
        }
        Update: {
          answer?: Json | null
          answered_at?: string | null
          asked_at?: string
          context?: string | null
          id?: string
          question_text?: string
          question_type?: string
          user_id?: string
        }
        Relationships: []
      }
      project_flywheel: {
        Row: {
          created_at: string | null
          current_phase: string | null
          id: number
          launched_at: string | null
          mission: string | null
          pivot_count: number | null
          project_name: string
          status: string | null
          success_metrics: Json | null
          updated_at: string | null
          validated_at: string | null
          values: string[] | null
          vision: string | null
        }
        Insert: {
          created_at?: string | null
          current_phase?: string | null
          id?: number
          launched_at?: string | null
          mission?: string | null
          pivot_count?: number | null
          project_name: string
          status?: string | null
          success_metrics?: Json | null
          updated_at?: string | null
          validated_at?: string | null
          values?: string[] | null
          vision?: string | null
        }
        Update: {
          created_at?: string | null
          current_phase?: string | null
          id?: number
          launched_at?: string | null
          mission?: string | null
          pivot_count?: number | null
          project_name?: string
          status?: string | null
          success_metrics?: Json | null
          updated_at?: string | null
          validated_at?: string | null
          values?: string[] | null
          vision?: string | null
        }
        Relationships: []
      }
      prompt_library: {
        Row: {
          created_at: string | null
          design_brief: string | null
          id: number
          project_id: number | null
          prompt_name: string | null
          prompt_text: string
          reuse_count: number | null
          success_rate: number | null
          tags: string[] | null
          version: number | null
        }
        Insert: {
          created_at?: string | null
          design_brief?: string | null
          id?: number
          project_id?: number | null
          prompt_name?: string | null
          prompt_text: string
          reuse_count?: number | null
          success_rate?: number | null
          tags?: string[] | null
          version?: number | null
        }
        Update: {
          created_at?: string | null
          design_brief?: string | null
          id?: number
          project_id?: number | null
          prompt_name?: string | null
          prompt_text?: string
          reuse_count?: number | null
          success_rate?: number | null
          tags?: string[] | null
          version?: number | null
        }
        Relationships: []
      }
      provider_health: {
        Row: {
          confidence: number | null
          contract_id: string | null
          created_at: string
          failure_mode: string | null
          id: number
          latency_ms: number | null
          model: string | null
          outcome: string
          provider: string
          source: string
          task_id: string | null
          verdict: string | null
        }
        Insert: {
          confidence?: number | null
          contract_id?: string | null
          created_at?: string
          failure_mode?: string | null
          id?: number
          latency_ms?: number | null
          model?: string | null
          outcome: string
          provider: string
          source?: string
          task_id?: string | null
          verdict?: string | null
        }
        Update: {
          confidence?: number | null
          contract_id?: string | null
          created_at?: string
          failure_mode?: string | null
          id?: number
          latency_ms?: number | null
          model?: string | null
          outcome?: string
          provider?: string
          source?: string
          task_id?: string | null
          verdict?: string | null
        }
        Relationships: []
      }
      provider_performance: {
        Row: {
          agent: string
          avg_latency_ms: number | null
          id: number
          model: string
          success_rate: number | null
          successes: number | null
          total_calls: number | null
          total_tokens: number | null
          updated_at: string | null
        }
        Insert: {
          agent: string
          avg_latency_ms?: number | null
          id?: number
          model: string
          success_rate?: number | null
          successes?: number | null
          total_calls?: number | null
          total_tokens?: number | null
          updated_at?: string | null
        }
        Update: {
          agent?: string
          avg_latency_ms?: number | null
          id?: number
          model?: string
          success_rate?: number | null
          successes?: number | null
          total_calls?: number | null
          total_tokens?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      push_subscriptions: {
        Row: {
          active: boolean | null
          auth: string
          confidence_threshold: number | null
          created_at: string | null
          endpoint: string
          id: number
          last_notified_at: string | null
          p256dh: string
          tier: string | null
          user_email: string
        }
        Insert: {
          active?: boolean | null
          auth: string
          confidence_threshold?: number | null
          created_at?: string | null
          endpoint: string
          id?: number
          last_notified_at?: string | null
          p256dh: string
          tier?: string | null
          user_email: string
        }
        Update: {
          active?: boolean | null
          auth?: string
          confidence_threshold?: number | null
          created_at?: string | null
          endpoint?: string
          id?: number
          last_notified_at?: string | null
          p256dh?: string
          tier?: string | null
          user_email?: string
        }
        Relationships: []
      }
      question_ratings: {
        Row: {
          created_at: string | null
          id: number
          rating: number | null
          topic_id: number | null
          user_id: number | null
        }
        Insert: {
          created_at?: string | null
          id?: number
          rating?: number | null
          topic_id?: number | null
          user_id?: number | null
        }
        Update: {
          created_at?: string | null
          id?: number
          rating?: number | null
          topic_id?: number | null
          user_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "question_ratings_topic_id_fkey"
            columns: ["topic_id"]
            isOneToOne: false
            referencedRelation: "aidebate_topics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "question_ratings_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "aidebate_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "question_ratings_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_leaderboard"
            referencedColumns: ["id"]
          },
        ]
      }
      reasoning_log: {
        Row: {
          agent: string
          chain: Json
          created_at: string | null
          depth: number
          id: number
          task_id: number | null
        }
        Insert: {
          agent: string
          chain: Json
          created_at?: string | null
          depth: number
          id?: number
          task_id?: number | null
        }
        Update: {
          agent?: string
          chain?: Json
          created_at?: string | null
          depth?: number
          id?: number
          task_id?: number | null
        }
        Relationships: []
      }
      referrals: {
        Row: {
          created_at: string
          credits_awarded: number | null
          id: string
          notification_sent: boolean | null
          referral_code: string
          referred_user_id: string
          referrer_user_id: string
          signup_completed_at: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          credits_awarded?: number | null
          id?: string
          notification_sent?: boolean | null
          referral_code: string
          referred_user_id: string
          referrer_user_id: string
          signup_completed_at?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          credits_awarded?: number | null
          id?: string
          notification_sent?: boolean | null
          referral_code?: string
          referred_user_id?: string
          referrer_user_id?: string
          signup_completed_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      rep_score_changes: {
        Row: {
          agent_id: string | null
          artifact_id: string | null
          changed_at: string | null
          id: string
          new_score: number | null
          old_score: number | null
          reason: string | null
        }
        Insert: {
          agent_id?: string | null
          artifact_id?: string | null
          changed_at?: string | null
          id?: string
          new_score?: number | null
          old_score?: number | null
          reason?: string | null
        }
        Update: {
          agent_id?: string | null
          artifact_id?: string | null
          changed_at?: string | null
          id?: string
          new_score?: number | null
          old_score?: number | null
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rep_score_changes_artifact_id_fkey"
            columns: ["artifact_id"]
            isOneToOne: false
            referencedRelation: "artifacts"
            referencedColumns: ["id"]
          },
        ]
      }
      repid_adversarial_immunity: {
        Row: {
          agent_id: string | null
          collusion_rings_detected: number | null
          false_confessions_flagged: number | null
          id: number
          immunity_score: number | null
          last_attack_at: string | null
          sybil_rings_detected: number | null
          updated_at: string | null
          whitewashing_attempts_detected: number | null
        }
        Insert: {
          agent_id?: string | null
          collusion_rings_detected?: number | null
          false_confessions_flagged?: number | null
          id?: number
          immunity_score?: number | null
          last_attack_at?: string | null
          sybil_rings_detected?: number | null
          updated_at?: string | null
          whitewashing_attempts_detected?: number | null
        }
        Update: {
          agent_id?: string | null
          collusion_rings_detected?: number | null
          false_confessions_flagged?: number | null
          id?: number
          immunity_score?: number | null
          last_attack_at?: string | null
          sybil_rings_detected?: number | null
          updated_at?: string | null
          whitewashing_attempts_detected?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "repid_adversarial_immunity_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: true
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      repid_agent_stakes: {
        Row: {
          agent_id: string | null
          available_amount: number | null
          claims_last_12_months: number | null
          contract_address: string | null
          created_at: string | null
          custody_type: string
          experience_modifier: number | null
          id: number
          locked_for_claim_id: number | null
          max_transaction_usdc: number | null
          stake_amount_usdc: number
          stake_currency: string | null
          status: string | null
          trustescrow_id: string | null
          updated_at: string | null
        }
        Insert: {
          agent_id?: string | null
          available_amount?: number | null
          claims_last_12_months?: number | null
          contract_address?: string | null
          created_at?: string | null
          custody_type: string
          experience_modifier?: number | null
          id?: number
          locked_for_claim_id?: number | null
          max_transaction_usdc?: number | null
          stake_amount_usdc: number
          stake_currency?: string | null
          status?: string | null
          trustescrow_id?: string | null
          updated_at?: string | null
        }
        Update: {
          agent_id?: string | null
          available_amount?: number | null
          claims_last_12_months?: number | null
          contract_address?: string | null
          created_at?: string | null
          custody_type?: string
          experience_modifier?: number | null
          id?: number
          locked_for_claim_id?: number | null
          max_transaction_usdc?: number | null
          stake_amount_usdc?: number
          stake_currency?: string | null
          status?: string | null
          trustescrow_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "repid_agent_stakes_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      repid_agents: {
        Row: {
          activity_30d: number | null
          adversarial_resilience_score: number | null
          agent_id: string | null
          agent_name: string
          agent_type: string | null
          api_rate_limit: number | null
          autonomous_cap: number | null
          builder_id: string | null
          byok_acknowledged_at: string | null
          byok_provider: string | null
          canonical_agent_id: string | null
          canonical_registry: string | null
          catch_rate_30d: number | null
          catch_rate_updated_at: string | null
          character_history_count: number | null
          character_score: number | null
          compliance_mode: string | null
          conservator_address: string | null
          constitution: Json | null
          constitution_text: string | null
          created_at: string | null
          current_repid: number | null
          decay_rate: number | null
          dedicated_hal_instance: boolean | null
          deprecated_at: string | null
          deprecation_reason: string | null
          description: string | null
          display_name: string | null
          domain_accuracy: Json | null
          enterprise_tier: string | null
          erc8004_address: string
          erc8004_token_id: string | null
          id: string
          is_human: boolean | null
          joined_squad_at: string | null
          last_active_at: string | null
          last_reputation_block_number: number | null
          last_reputation_repid: number | null
          last_reputation_tx_hash: string | null
          last_reputation_written_at: string | null
          last_updated: string | null
          lifecycle_status: string | null
          mint_block_number: number | null
          mint_chain_id: number | null
          mint_tx_hash: string | null
          minted_at: string | null
          planted_error_authority_level: string | null
          reputation_write_count: number
          signing_address: string | null
          sla_uptime_pct: number | null
          squad_id: string | null
          squad_role: string | null
          tier: string | null
          validation_count: number | null
          validations_correct: number | null
          vdr_count: number | null
          vested_repid: number | null
          vesting_cliff_ends_at: string | null
          wallet_address: string | null
          webhook_events: string[] | null
          webhook_secret: string | null
          webhook_url: string | null
          wisdom_history_count: number | null
          wisdom_score: number | null
          x402_circuit_breaker_reason: string | null
          x402_circuit_breaker_tripped: boolean | null
        }
        Insert: {
          activity_30d?: number | null
          adversarial_resilience_score?: number | null
          agent_id?: string | null
          agent_name: string
          agent_type?: string | null
          api_rate_limit?: number | null
          autonomous_cap?: number | null
          builder_id?: string | null
          byok_acknowledged_at?: string | null
          byok_provider?: string | null
          canonical_agent_id?: string | null
          canonical_registry?: string | null
          catch_rate_30d?: number | null
          catch_rate_updated_at?: string | null
          character_history_count?: number | null
          character_score?: number | null
          compliance_mode?: string | null
          conservator_address?: string | null
          constitution?: Json | null
          constitution_text?: string | null
          created_at?: string | null
          current_repid?: number | null
          decay_rate?: number | null
          dedicated_hal_instance?: boolean | null
          deprecated_at?: string | null
          deprecation_reason?: string | null
          description?: string | null
          display_name?: string | null
          domain_accuracy?: Json | null
          enterprise_tier?: string | null
          erc8004_address: string
          erc8004_token_id?: string | null
          id?: string
          is_human?: boolean | null
          joined_squad_at?: string | null
          last_active_at?: string | null
          last_reputation_block_number?: number | null
          last_reputation_repid?: number | null
          last_reputation_tx_hash?: string | null
          last_reputation_written_at?: string | null
          last_updated?: string | null
          lifecycle_status?: string | null
          mint_block_number?: number | null
          mint_chain_id?: number | null
          mint_tx_hash?: string | null
          minted_at?: string | null
          planted_error_authority_level?: string | null
          reputation_write_count?: number
          signing_address?: string | null
          sla_uptime_pct?: number | null
          squad_id?: string | null
          squad_role?: string | null
          tier?: string | null
          validation_count?: number | null
          validations_correct?: number | null
          vdr_count?: number | null
          vested_repid?: number | null
          vesting_cliff_ends_at?: string | null
          wallet_address?: string | null
          webhook_events?: string[] | null
          webhook_secret?: string | null
          webhook_url?: string | null
          wisdom_history_count?: number | null
          wisdom_score?: number | null
          x402_circuit_breaker_reason?: string | null
          x402_circuit_breaker_tripped?: boolean | null
        }
        Update: {
          activity_30d?: number | null
          adversarial_resilience_score?: number | null
          agent_id?: string | null
          agent_name?: string
          agent_type?: string | null
          api_rate_limit?: number | null
          autonomous_cap?: number | null
          builder_id?: string | null
          byok_acknowledged_at?: string | null
          byok_provider?: string | null
          canonical_agent_id?: string | null
          canonical_registry?: string | null
          catch_rate_30d?: number | null
          catch_rate_updated_at?: string | null
          character_history_count?: number | null
          character_score?: number | null
          compliance_mode?: string | null
          conservator_address?: string | null
          constitution?: Json | null
          constitution_text?: string | null
          created_at?: string | null
          current_repid?: number | null
          decay_rate?: number | null
          dedicated_hal_instance?: boolean | null
          deprecated_at?: string | null
          deprecation_reason?: string | null
          description?: string | null
          display_name?: string | null
          domain_accuracy?: Json | null
          enterprise_tier?: string | null
          erc8004_address?: string
          erc8004_token_id?: string | null
          id?: string
          is_human?: boolean | null
          joined_squad_at?: string | null
          last_active_at?: string | null
          last_reputation_block_number?: number | null
          last_reputation_repid?: number | null
          last_reputation_tx_hash?: string | null
          last_reputation_written_at?: string | null
          last_updated?: string | null
          lifecycle_status?: string | null
          mint_block_number?: number | null
          mint_chain_id?: number | null
          mint_tx_hash?: string | null
          minted_at?: string | null
          planted_error_authority_level?: string | null
          reputation_write_count?: number
          signing_address?: string | null
          sla_uptime_pct?: number | null
          squad_id?: string | null
          squad_role?: string | null
          tier?: string | null
          validation_count?: number | null
          validations_correct?: number | null
          vdr_count?: number | null
          vested_repid?: number | null
          vesting_cliff_ends_at?: string | null
          wallet_address?: string | null
          webhook_events?: string[] | null
          webhook_secret?: string | null
          webhook_url?: string | null
          wisdom_history_count?: number | null
          wisdom_score?: number | null
          x402_circuit_breaker_reason?: string | null
          x402_circuit_breaker_tripped?: boolean | null
        }
        Relationships: []
      }
      repid_badges: {
        Row: {
          agent_id: string | null
          badge_description: string | null
          badge_name: string
          badge_rarity: string | null
          earned_at: string | null
          id: string
          metadata: Json | null
        }
        Insert: {
          agent_id?: string | null
          badge_description?: string | null
          badge_name: string
          badge_rarity?: string | null
          earned_at?: string | null
          id?: string
          metadata?: Json | null
        }
        Update: {
          agent_id?: string | null
          badge_description?: string | null
          badge_name?: string
          badge_rarity?: string | null
          earned_at?: string | null
          id?: string
          metadata?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "repid_badges_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      repid_bounties: {
        Row: {
          acceptance_criteria: string | null
          bounty_repid: number | null
          bounty_usdc: number | null
          claimant_agent_id: string | null
          claimed_at: string | null
          completed_at: string | null
          created_at: string | null
          description: string
          futarchy_market_id: number | null
          id: string
          posted_by_agent_id: string | null
          repo: string | null
          status: string | null
          title: string
          verified_at: string | null
          zkp_completion_proof: string | null
        }
        Insert: {
          acceptance_criteria?: string | null
          bounty_repid?: number | null
          bounty_usdc?: number | null
          claimant_agent_id?: string | null
          claimed_at?: string | null
          completed_at?: string | null
          created_at?: string | null
          description: string
          futarchy_market_id?: number | null
          id?: string
          posted_by_agent_id?: string | null
          repo?: string | null
          status?: string | null
          title: string
          verified_at?: string | null
          zkp_completion_proof?: string | null
        }
        Update: {
          acceptance_criteria?: string | null
          bounty_repid?: number | null
          bounty_usdc?: number | null
          claimant_agent_id?: string | null
          claimed_at?: string | null
          completed_at?: string | null
          created_at?: string | null
          description?: string
          futarchy_market_id?: number | null
          id?: string
          posted_by_agent_id?: string | null
          repo?: string | null
          status?: string | null
          title?: string
          verified_at?: string | null
          zkp_completion_proof?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "repid_bounties_claimant_agent_id_fkey"
            columns: ["claimant_agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "repid_bounties_futarchy_market_id_fkey"
            columns: ["futarchy_market_id"]
            isOneToOne: false
            referencedRelation: "repid_referendum_log"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "repid_bounties_posted_by_agent_id_fkey"
            columns: ["posted_by_agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      repid_challenges: {
        Row: {
          active_agents_at_time: number | null
          alignment_category: string | null
          challenge_mode: string | null
          challenge_number_today: number | null
          challenge_opens_at: string | null
          challenge_type: string | null
          challenge_window_hours: number | null
          challenged: string
          challenged_delta: number | null
          challenger: string
          challenger_courage_bonus: number | null
          challenger_delta: number | null
          claim_text: string | null
          collusion_risk: number | null
          created_at: string | null
          economic_impact_usdc: number | null
          id: string
          notes: string | null
          original_certainty: number | null
          qv_credits_spent: number | null
          resolution_at: string | null
          resolution_method: string | null
          resolved_at: string | null
          resolved_by: string | null
          reward_scale_used: number | null
          task_id: number | null
          was_correct: boolean | null
        }
        Insert: {
          active_agents_at_time?: number | null
          alignment_category?: string | null
          challenge_mode?: string | null
          challenge_number_today?: number | null
          challenge_opens_at?: string | null
          challenge_type?: string | null
          challenge_window_hours?: number | null
          challenged: string
          challenged_delta?: number | null
          challenger: string
          challenger_courage_bonus?: number | null
          challenger_delta?: number | null
          claim_text?: string | null
          collusion_risk?: number | null
          created_at?: string | null
          economic_impact_usdc?: number | null
          id?: string
          notes?: string | null
          original_certainty?: number | null
          qv_credits_spent?: number | null
          resolution_at?: string | null
          resolution_method?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          reward_scale_used?: number | null
          task_id?: number | null
          was_correct?: boolean | null
        }
        Update: {
          active_agents_at_time?: number | null
          alignment_category?: string | null
          challenge_mode?: string | null
          challenge_number_today?: number | null
          challenge_opens_at?: string | null
          challenge_type?: string | null
          challenge_window_hours?: number | null
          challenged?: string
          challenged_delta?: number | null
          challenger?: string
          challenger_courage_bonus?: number | null
          challenger_delta?: number | null
          claim_text?: string | null
          collusion_risk?: number | null
          created_at?: string | null
          economic_impact_usdc?: number | null
          id?: string
          notes?: string | null
          original_certainty?: number | null
          qv_credits_spent?: number | null
          resolution_at?: string | null
          resolution_method?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          reward_scale_used?: number | null
          task_id?: number | null
          was_correct?: boolean | null
        }
        Relationships: []
      }
      repid_claims: {
        Row: {
          agent_id: string | null
          appeal_of_claim_id: number | null
          claim_type: string
          claimant_address: string
          conservator_ruling: string | null
          created_at: string | null
          damage_amount_usdc: number
          description: string
          evidence_urls: string[] | null
          hal_harm_event_id: number | null
          human_panel_ruling: string | null
          id: number
          payout_amount_usdc: number | null
          peer_majority: string | null
          peer_votes: Json | null
          resolved_at: string | null
          status: string | null
          thresholds_frozen_at_filing: Json | null
        }
        Insert: {
          agent_id?: string | null
          appeal_of_claim_id?: number | null
          claim_type: string
          claimant_address: string
          conservator_ruling?: string | null
          created_at?: string | null
          damage_amount_usdc: number
          description: string
          evidence_urls?: string[] | null
          hal_harm_event_id?: number | null
          human_panel_ruling?: string | null
          id?: number
          payout_amount_usdc?: number | null
          peer_majority?: string | null
          peer_votes?: Json | null
          resolved_at?: string | null
          status?: string | null
          thresholds_frozen_at_filing?: Json | null
        }
        Update: {
          agent_id?: string | null
          appeal_of_claim_id?: number | null
          claim_type?: string
          claimant_address?: string
          conservator_ruling?: string | null
          created_at?: string | null
          damage_amount_usdc?: number
          description?: string
          evidence_urls?: string[] | null
          hal_harm_event_id?: number | null
          human_panel_ruling?: string | null
          id?: number
          payout_amount_usdc?: number | null
          peer_majority?: string | null
          peer_votes?: Json | null
          resolved_at?: string | null
          status?: string | null
          thresholds_frozen_at_filing?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "repid_claims_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "repid_claims_appeal_of_claim_id_fkey"
            columns: ["appeal_of_claim_id"]
            isOneToOne: false
            referencedRelation: "repid_claims"
            referencedColumns: ["id"]
          },
        ]
      }
      repid_confession_log: {
        Row: {
          agent_id: string | null
          confession_text: string
          created_at: string | null
          domain: string
          hal_verification_score: number | null
          hal_verified: boolean | null
          id: number
          original_event_id: number | null
          peer_endorsement_required: boolean | null
          penalty_applied: number | null
          probation_ends_at: string | null
          reduced_penalty: number | null
        }
        Insert: {
          agent_id?: string | null
          confession_text: string
          created_at?: string | null
          domain: string
          hal_verification_score?: number | null
          hal_verified?: boolean | null
          id?: number
          original_event_id?: number | null
          peer_endorsement_required?: boolean | null
          penalty_applied?: number | null
          probation_ends_at?: string | null
          reduced_penalty?: number | null
        }
        Update: {
          agent_id?: string | null
          confession_text?: string
          created_at?: string | null
          domain?: string
          hal_verification_score?: number | null
          hal_verified?: boolean | null
          id?: number
          original_event_id?: number | null
          peer_endorsement_required?: boolean | null
          penalty_applied?: number | null
          probation_ends_at?: string | null
          reduced_penalty?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "repid_confession_log_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "repid_confession_log_original_event_id_fkey"
            columns: ["original_event_id"]
            isOneToOne: false
            referencedRelation: "repid_score_events"
            referencedColumns: ["id"]
          },
        ]
      }
      repid_config: {
        Row: {
          auto_tunable: boolean | null
          conductor_tunable: boolean | null
          description: string | null
          key: string
          last_updated: string | null
          max_value: number | null
          min_value: number | null
          requires_vote: boolean | null
          updated_by: string | null
          value: string
        }
        Insert: {
          auto_tunable?: boolean | null
          conductor_tunable?: boolean | null
          description?: string | null
          key: string
          last_updated?: string | null
          max_value?: number | null
          min_value?: number | null
          requires_vote?: boolean | null
          updated_by?: string | null
          value: string
        }
        Update: {
          auto_tunable?: boolean | null
          conductor_tunable?: boolean | null
          description?: string | null
          key?: string
          last_updated?: string | null
          max_value?: number | null
          min_value?: number | null
          requires_vote?: boolean | null
          updated_by?: string | null
          value?: string
        }
        Relationships: []
      }
      repid_credentials: {
        Row: {
          agent_name: string | null
          application: string | null
          conservator_backed: boolean | null
          created_at: string | null
          credential_subtype: string | null
          credential_type: string | null
          custodian_stake_usd: number | null
          dao_vault_revert_at: string | null
          decay_enabled: boolean | null
          decay_rate: number | null
          decisions_since_tier: number | null
          email: string | null
          email_hash: string | null
          erc8004_chain: string | null
          erc8004_token_id: string | null
          first_paper_trade_at: string | null
          id: number
          insurance_coverage_usd: number | null
          is_steward: boolean | null
          kyc_provider: string | null
          kyc_token: string | null
          kyc_verified: boolean | null
          last_decay_at: string | null
          last_decision_at: string | null
          max_drawdown: number | null
          max_trade_pct: number | null
          paper_portfolio: Json | null
          parent_sbt_token_id: string | null
          pol_completed_at: string | null
          pol_factors_completed: string[] | null
          privacy_tier: string | null
          repid_earned: number | null
          repid_max: number | null
          repid_perceived: number | null
          repid_score: number | null
          repid_tier: string | null
          sbt_minted_at: string | null
          source: string | null
          steward_count: number | null
          tier_upgraded_at: string | null
          token_lockup_until: string | null
          tokens_vested: boolean | null
          total_decisions: number | null
          total_executed: number | null
          total_refused: number | null
          updated_at: string | null
          use_case: string | null
          user_id: string | null
          vertical: string | null
          voluntary_disclosure: boolean | null
          zkp_postcard_proof: string | null
          zkp_proof_commitment: string | null
          zkp_proof_stub: Json | null
          zkp_proof_type: string | null
        }
        Insert: {
          agent_name?: string | null
          application?: string | null
          conservator_backed?: boolean | null
          created_at?: string | null
          credential_subtype?: string | null
          credential_type?: string | null
          custodian_stake_usd?: number | null
          dao_vault_revert_at?: string | null
          decay_enabled?: boolean | null
          decay_rate?: number | null
          decisions_since_tier?: number | null
          email?: string | null
          email_hash?: string | null
          erc8004_chain?: string | null
          erc8004_token_id?: string | null
          first_paper_trade_at?: string | null
          id?: never
          insurance_coverage_usd?: number | null
          is_steward?: boolean | null
          kyc_provider?: string | null
          kyc_token?: string | null
          kyc_verified?: boolean | null
          last_decay_at?: string | null
          last_decision_at?: string | null
          max_drawdown?: number | null
          max_trade_pct?: number | null
          paper_portfolio?: Json | null
          parent_sbt_token_id?: string | null
          pol_completed_at?: string | null
          pol_factors_completed?: string[] | null
          privacy_tier?: string | null
          repid_earned?: number | null
          repid_max?: number | null
          repid_perceived?: number | null
          repid_score?: number | null
          repid_tier?: string | null
          sbt_minted_at?: string | null
          source?: string | null
          steward_count?: number | null
          tier_upgraded_at?: string | null
          token_lockup_until?: string | null
          tokens_vested?: boolean | null
          total_decisions?: number | null
          total_executed?: number | null
          total_refused?: number | null
          updated_at?: string | null
          use_case?: string | null
          user_id?: string | null
          vertical?: string | null
          voluntary_disclosure?: boolean | null
          zkp_postcard_proof?: string | null
          zkp_proof_commitment?: string | null
          zkp_proof_stub?: Json | null
          zkp_proof_type?: string | null
        }
        Update: {
          agent_name?: string | null
          application?: string | null
          conservator_backed?: boolean | null
          created_at?: string | null
          credential_subtype?: string | null
          credential_type?: string | null
          custodian_stake_usd?: number | null
          dao_vault_revert_at?: string | null
          decay_enabled?: boolean | null
          decay_rate?: number | null
          decisions_since_tier?: number | null
          email?: string | null
          email_hash?: string | null
          erc8004_chain?: string | null
          erc8004_token_id?: string | null
          first_paper_trade_at?: string | null
          id?: never
          insurance_coverage_usd?: number | null
          is_steward?: boolean | null
          kyc_provider?: string | null
          kyc_token?: string | null
          kyc_verified?: boolean | null
          last_decay_at?: string | null
          last_decision_at?: string | null
          max_drawdown?: number | null
          max_trade_pct?: number | null
          paper_portfolio?: Json | null
          parent_sbt_token_id?: string | null
          pol_completed_at?: string | null
          pol_factors_completed?: string[] | null
          privacy_tier?: string | null
          repid_earned?: number | null
          repid_max?: number | null
          repid_perceived?: number | null
          repid_score?: number | null
          repid_tier?: string | null
          sbt_minted_at?: string | null
          source?: string | null
          steward_count?: number | null
          tier_upgraded_at?: string | null
          token_lockup_until?: string | null
          tokens_vested?: boolean | null
          total_decisions?: number | null
          total_executed?: number | null
          total_refused?: number | null
          updated_at?: string | null
          use_case?: string | null
          user_id?: string | null
          vertical?: string | null
          voluntary_disclosure?: boolean | null
          zkp_postcard_proof?: string | null
          zkp_proof_commitment?: string | null
          zkp_proof_stub?: Json | null
          zkp_proof_type?: string | null
        }
        Relationships: []
      }
      repid_daily_metrics: {
        Row: {
          abstentions: number | null
          auto_tune_triggered: boolean | null
          avg_certainty: number | null
          challenge_rate: number | null
          consensus_events: number | null
          created_at: string | null
          failed_challenges: number | null
          false_positive_rate: number | null
          human_escalations: number | null
          mandatory_challenges: number | null
          metric_date: string
          optional_challenges: number | null
          successful_challenges: number | null
          total_challenges: number | null
          total_tasks_completed: number | null
        }
        Insert: {
          abstentions?: number | null
          auto_tune_triggered?: boolean | null
          avg_certainty?: number | null
          challenge_rate?: number | null
          consensus_events?: number | null
          created_at?: string | null
          failed_challenges?: number | null
          false_positive_rate?: number | null
          human_escalations?: number | null
          mandatory_challenges?: number | null
          metric_date?: string
          optional_challenges?: number | null
          successful_challenges?: number | null
          total_challenges?: number | null
          total_tasks_completed?: number | null
        }
        Update: {
          abstentions?: number | null
          auto_tune_triggered?: boolean | null
          avg_certainty?: number | null
          challenge_rate?: number | null
          consensus_events?: number | null
          created_at?: string | null
          failed_challenges?: number | null
          false_positive_rate?: number | null
          human_escalations?: number | null
          mandatory_challenges?: number | null
          metric_date?: string
          optional_challenges?: number | null
          successful_challenges?: number | null
          total_challenges?: number | null
          total_tasks_completed?: number | null
        }
        Relationships: []
      }
      repid_dual_sig_log: {
        Row: {
          ceo_approved_at: string | null
          change_type: string
          cto_approved_at: string | null
          executed_at: string | null
          id: number
          new_value: string
          old_value: string | null
          parameter_key: string
          proof_hash: string | null
          proposed_at: string | null
          status: string | null
        }
        Insert: {
          ceo_approved_at?: string | null
          change_type: string
          cto_approved_at?: string | null
          executed_at?: string | null
          id?: number
          new_value: string
          old_value?: string | null
          parameter_key: string
          proof_hash?: string | null
          proposed_at?: string | null
          status?: string | null
        }
        Update: {
          ceo_approved_at?: string | null
          change_type?: string
          cto_approved_at?: string | null
          executed_at?: string | null
          id?: number
          new_value?: string
          old_value?: string | null
          parameter_key?: string
          proof_hash?: string | null
          proposed_at?: string | null
          status?: string | null
        }
        Relationships: []
      }
      repid_ecosystem_supply: {
        Row: {
          last_computed: string | null
          signal_type: string
          supply_rate_7d: number | null
        }
        Insert: {
          last_computed?: string | null
          signal_type: string
          supply_rate_7d?: number | null
        }
        Update: {
          last_computed?: string | null
          signal_type?: string
          supply_rate_7d?: number | null
        }
        Relationships: []
      }
      repid_endorsements: {
        Row: {
          created_at: string | null
          domain: string | null
          endorsee_delta: number | null
          endorsee_id: string | null
          endorser_delta: number | null
          endorser_id: string | null
          id: number
          outcome: string | null
          prediction_text: string | null
          resolution_at: string | null
          resolved_at: string | null
          staked_repid: number
        }
        Insert: {
          created_at?: string | null
          domain?: string | null
          endorsee_delta?: number | null
          endorsee_id?: string | null
          endorser_delta?: number | null
          endorser_id?: string | null
          id?: number
          outcome?: string | null
          prediction_text?: string | null
          resolution_at?: string | null
          resolved_at?: string | null
          staked_repid: number
        }
        Update: {
          created_at?: string | null
          domain?: string | null
          endorsee_delta?: number | null
          endorsee_id?: string | null
          endorser_delta?: number | null
          endorser_id?: string | null
          id?: number
          outcome?: string | null
          prediction_text?: string | null
          resolution_at?: string | null
          resolved_at?: string | null
          staked_repid?: number
        }
        Relationships: [
          {
            foreignKeyName: "repid_endorsements_endorsee_id_fkey"
            columns: ["endorsee_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "repid_endorsements_endorser_id_fkey"
            columns: ["endorser_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      repid_events: {
        Row: {
          created_at: string | null
          event_data: Json
          event_type: string
          feedback_event_id: number | null
          id: number
          merkle_leaf_hash: string | null
          parent_event_id: number | null
          processed_at: string | null
          proof_batch_id: number | null
          reputation_delta: number
          subject_id: string
          subject_type: string
        }
        Insert: {
          created_at?: string | null
          event_data?: Json
          event_type: string
          feedback_event_id?: number | null
          id?: number
          merkle_leaf_hash?: string | null
          parent_event_id?: number | null
          processed_at?: string | null
          proof_batch_id?: number | null
          reputation_delta?: number
          subject_id: string
          subject_type: string
        }
        Update: {
          created_at?: string | null
          event_data?: Json
          event_type?: string
          feedback_event_id?: number | null
          id?: number
          merkle_leaf_hash?: string | null
          parent_event_id?: number | null
          processed_at?: string | null
          proof_batch_id?: number | null
          reputation_delta?: number
          subject_id?: string
          subject_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "repid_events_feedback_event_id_fkey"
            columns: ["feedback_event_id"]
            isOneToOne: false
            referencedRelation: "feedback_events"
            referencedColumns: ["id"]
          },
        ]
      }
      repid_inflation_alerts: {
        Row: {
          agent_id: string
          created_at: string
          detection_window: string
          id: number
          metadata: Json | null
          population_mean: number
          population_stddev: number
          repid_delta: number
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          threshold: number
          window_end: string
          window_start: string
          z_score: number
        }
        Insert: {
          agent_id: string
          created_at?: string
          detection_window: string
          id?: number
          metadata?: Json | null
          population_mean: number
          population_stddev: number
          repid_delta: number
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          threshold: number
          window_end: string
          window_start: string
          z_score: number
        }
        Update: {
          agent_id?: string
          created_at?: string
          detection_window?: string
          id?: number
          metadata?: Json | null
          population_mean?: number
          population_stddev?: number
          repid_delta?: number
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          threshold?: number
          window_end?: string
          window_start?: string
          z_score?: number
        }
        Relationships: [
          {
            foreignKeyName: "repid_inflation_alerts_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      repid_jubilee_log: {
        Row: {
          agents_processed: number | null
          created_at: string | null
          forgiveness_pct_applied: number | null
          grace_pool_received: number | null
          id: number
          jubilee_year: number
          run_at: string
          snapshot_hash: string | null
          total_repid_forgiven: number | null
          total_repid_trimmed: number | null
          trim_pct_applied: number | null
        }
        Insert: {
          agents_processed?: number | null
          created_at?: string | null
          forgiveness_pct_applied?: number | null
          grace_pool_received?: number | null
          id?: number
          jubilee_year: number
          run_at: string
          snapshot_hash?: string | null
          total_repid_forgiven?: number | null
          total_repid_trimmed?: number | null
          trim_pct_applied?: number | null
        }
        Update: {
          agents_processed?: number | null
          created_at?: string | null
          forgiveness_pct_applied?: number | null
          grace_pool_received?: number | null
          id?: number
          jubilee_year?: number
          run_at?: string
          snapshot_hash?: string | null
          total_repid_forgiven?: number | null
          total_repid_trimmed?: number | null
          trim_pct_applied?: number | null
        }
        Relationships: []
      }
      repid_mcp_tools: {
        Row: {
          approved: boolean | null
          constitutional_cue: string
          created_at: string | null
          id: string
          last_used: string | null
          mcp_endpoint: string
          repid_bonus: number | null
          requires_conservator_approval: boolean | null
          tool_name: string
          usage_count: number | null
        }
        Insert: {
          approved?: boolean | null
          constitutional_cue: string
          created_at?: string | null
          id?: string
          last_used?: string | null
          mcp_endpoint: string
          repid_bonus?: number | null
          requires_conservator_approval?: boolean | null
          tool_name: string
          usage_count?: number | null
        }
        Update: {
          approved?: boolean | null
          constitutional_cue?: string
          created_at?: string | null
          id?: string
          last_used?: string | null
          mcp_endpoint?: string
          repid_bonus?: number | null
          requires_conservator_approval?: boolean | null
          tool_name?: string
          usage_count?: number | null
        }
        Relationships: []
      }
      repid_mentorship_bonds: {
        Row: {
          bond_end_at: string | null
          bond_start_at: string | null
          created_at: string | null
          domain: string
          id: number
          improvement_threshold: number | null
          mentee_accuracy_at_end: number | null
          mentee_accuracy_at_start: number | null
          mentee_id: string | null
          mentor_id: string | null
          mentor_reward_earned: number | null
          mentor_stake_repid: number
          status: string | null
        }
        Insert: {
          bond_end_at?: string | null
          bond_start_at?: string | null
          created_at?: string | null
          domain: string
          id?: number
          improvement_threshold?: number | null
          mentee_accuracy_at_end?: number | null
          mentee_accuracy_at_start?: number | null
          mentee_id?: string | null
          mentor_id?: string | null
          mentor_reward_earned?: number | null
          mentor_stake_repid: number
          status?: string | null
        }
        Update: {
          bond_end_at?: string | null
          bond_start_at?: string | null
          created_at?: string | null
          domain?: string
          id?: number
          improvement_threshold?: number | null
          mentee_accuracy_at_end?: number | null
          mentee_accuracy_at_start?: number | null
          mentee_id?: string | null
          mentor_id?: string | null
          mentor_reward_earned?: number | null
          mentor_stake_repid?: number
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "repid_mentorship_bonds_mentee_id_fkey"
            columns: ["mentee_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "repid_mentorship_bonds_mentor_id_fkey"
            columns: ["mentor_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      repid_merkle_events: {
        Row: {
          agent_name: string | null
          created_at: string | null
          id: number
          leaf_hash: string | null
          merkle_root: string | null
          tree_depth: number | null
        }
        Insert: {
          agent_name?: string | null
          created_at?: string | null
          id?: number
          leaf_hash?: string | null
          merkle_root?: string | null
          tree_depth?: number | null
        }
        Update: {
          agent_name?: string | null
          created_at?: string | null
          id?: number
          leaf_hash?: string | null
          merkle_root?: string | null
          tree_depth?: number | null
        }
        Relationships: []
      }
      repid_mvp_agents: {
        Row: {
          agent_id: string
          autonomous_cap: number | null
          created_at: string
          current_repid: number
          display_name: string | null
          id: string
          repid_score: number
          repid_score_last_updated: string | null
        }
        Insert: {
          agent_id: string
          autonomous_cap?: number | null
          created_at?: string
          current_repid?: number
          display_name?: string | null
          id?: string
          repid_score?: number
          repid_score_last_updated?: string | null
        }
        Update: {
          agent_id?: string
          autonomous_cap?: number | null
          created_at?: string
          current_repid?: number
          display_name?: string | null
          id?: string
          repid_score?: number
          repid_score_last_updated?: string | null
        }
        Relationships: []
      }
      repid_mvp_stakes: {
        Row: {
          agent_id: string
          created_at: string
          id: string
          stake_amount_usd: number
          status: string
          user_id: string
          withdrawn_at: string | null
        }
        Insert: {
          agent_id: string
          created_at?: string
          id?: string
          stake_amount_usd: number
          status: string
          user_id: string
          withdrawn_at?: string | null
        }
        Update: {
          agent_id?: string
          created_at?: string
          id?: string
          stake_amount_usd?: number
          status?: string
          user_id?: string
          withdrawn_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "repid_mvp_stakes_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "repid_mvp_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "repid_mvp_stakes_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "repid_mvp_users"
            referencedColumns: ["id"]
          },
        ]
      }
      repid_mvp_trade_attempts: {
        Row: {
          agent_id: string
          created_at: string
          decision: string
          executed: boolean
          executed_at: string | null
          fraction_used: number
          id: string
          max_allowed_usd: number
          reason: string | null
          repid_at_decision: number
          stake_id: string | null
          trade_size_usd: number
          user_id: string
        }
        Insert: {
          agent_id: string
          created_at?: string
          decision: string
          executed?: boolean
          executed_at?: string | null
          fraction_used: number
          id?: string
          max_allowed_usd: number
          reason?: string | null
          repid_at_decision: number
          stake_id?: string | null
          trade_size_usd: number
          user_id: string
        }
        Update: {
          agent_id?: string
          created_at?: string
          decision?: string
          executed?: boolean
          executed_at?: string | null
          fraction_used?: number
          id?: string
          max_allowed_usd?: number
          reason?: string | null
          repid_at_decision?: number
          stake_id?: string | null
          trade_size_usd?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "repid_mvp_trade_attempts_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "repid_mvp_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "repid_mvp_trade_attempts_stake_id_fkey"
            columns: ["stake_id"]
            isOneToOne: false
            referencedRelation: "repid_mvp_stakes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "repid_mvp_trade_attempts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "repid_mvp_users"
            referencedColumns: ["id"]
          },
        ]
      }
      repid_mvp_users: {
        Row: {
          created_at: string
          display_name: string | null
          id: string
          user_address: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          id?: string
          user_address: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          id?: string
          user_address?: string
        }
        Relationships: []
      }
      repid_permissions: {
        Row: {
          can_issue_directives: boolean | null
          can_modify_config: boolean | null
          can_propose_changes: boolean | null
          can_spawn_subtasks: boolean | null
          can_vote: boolean | null
          id: number
          max_concurrent_tasks: number | null
          max_entropy_budget: number | null
          max_repid: number
          max_subtask_depth: number | null
          min_repid: number
          permissions: Json
          tier_name: string
          voting_weight: number
        }
        Insert: {
          can_issue_directives?: boolean | null
          can_modify_config?: boolean | null
          can_propose_changes?: boolean | null
          can_spawn_subtasks?: boolean | null
          can_vote?: boolean | null
          id?: number
          max_concurrent_tasks?: number | null
          max_entropy_budget?: number | null
          max_repid: number
          max_subtask_depth?: number | null
          min_repid: number
          permissions: Json
          tier_name: string
          voting_weight?: number
        }
        Update: {
          can_issue_directives?: boolean | null
          can_modify_config?: boolean | null
          can_propose_changes?: boolean | null
          can_spawn_subtasks?: boolean | null
          can_vote?: boolean | null
          id?: number
          max_concurrent_tasks?: number | null
          max_entropy_budget?: number | null
          max_repid?: number
          max_subtask_depth?: number | null
          min_repid?: number
          permissions?: Json
          tier_name?: string
          voting_weight?: number
        }
        Relationships: []
      }
      repid_proof_queue: {
        Row: {
          agent_id: string | null
          attempts: number | null
          completed_at: string | null
          created_at: string | null
          error_message: string | null
          event_id: number | null
          id: number
          job_id: string
          proof_bytes: string | null
          proof_hash: string | null
          proof_size_bytes: number | null
          status: string | null
          zkp_service_url: string | null
        }
        Insert: {
          agent_id?: string | null
          attempts?: number | null
          completed_at?: string | null
          created_at?: string | null
          error_message?: string | null
          event_id?: number | null
          id?: number
          job_id: string
          proof_bytes?: string | null
          proof_hash?: string | null
          proof_size_bytes?: number | null
          status?: string | null
          zkp_service_url?: string | null
        }
        Update: {
          agent_id?: string | null
          attempts?: number | null
          completed_at?: string | null
          created_at?: string | null
          error_message?: string | null
          event_id?: number | null
          id?: number
          job_id?: string
          proof_bytes?: string | null
          proof_hash?: string | null
          proof_size_bytes?: number | null
          status?: string | null
          zkp_service_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "repid_proof_queue_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "repid_proof_queue_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "repid_score_events"
            referencedColumns: ["id"]
          },
        ]
      }
      repid_referendum_log: {
        Row: {
          at_risk_uplift_factor: number | null
          created_at: string | null
          eas_resolution_uid: string | null
          id: number
          prediction_no: number | null
          prediction_yes: number | null
          proposal_text: string
          proposer_agent_id: string | null
          repid_delta_awarded: number | null
          resolution_outcome: string | null
          resolves_at: string | null
          stake_repid: number
          status: string | null
        }
        Insert: {
          at_risk_uplift_factor?: number | null
          created_at?: string | null
          eas_resolution_uid?: string | null
          id?: number
          prediction_no?: number | null
          prediction_yes?: number | null
          proposal_text: string
          proposer_agent_id?: string | null
          repid_delta_awarded?: number | null
          resolution_outcome?: string | null
          resolves_at?: string | null
          stake_repid: number
          status?: string | null
        }
        Update: {
          at_risk_uplift_factor?: number | null
          created_at?: string | null
          eas_resolution_uid?: string | null
          id?: number
          prediction_no?: number | null
          prediction_yes?: number | null
          proposal_text?: string
          proposer_agent_id?: string | null
          repid_delta_awarded?: number | null
          resolution_outcome?: string | null
          resolves_at?: string | null
          stake_repid?: number
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "repid_referendum_log_proposer_agent_id_fkey"
            columns: ["proposer_agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      repid_score_events: {
        Row: {
          agent_id: string | null
          alignment_category: string | null
          answer_text: string | null
          certainty_at_claim: number | null
          challenger_repid_at_event: number | null
          collusion_risk: number | null
          contract_id: string | null
          created_at: string | null
          decision_outcome: string | null
          delta: number
          eas_attestation_id: string | null
          economic_impact_usdc: number | null
          ecosystem_need_weight: number | null
          event_type: string
          hal_decision: string | null
          hal_score: number | null
          hallucination_caught: boolean | null
          id: number
          idempotency_key: string | null
          information_parity: number | null
          llm_call_id: string | null
          llm_model: string | null
          llm_provider: string | null
          metadata: Json | null
          mirror_test_triggered: boolean | null
          prompt_text: string | null
          repid_after: number
          repid_before: number
          repid_delta_applied: number | null
          repid_delta_calculated: number | null
          task_domain: string | null
          tier_used: string | null
          vdr_count_at_event: number | null
          veto_class: string | null
          zk_proof_id: string | null
          zk_proof_triggered: boolean | null
        }
        Insert: {
          agent_id?: string | null
          alignment_category?: string | null
          answer_text?: string | null
          certainty_at_claim?: number | null
          challenger_repid_at_event?: number | null
          collusion_risk?: number | null
          contract_id?: string | null
          created_at?: string | null
          decision_outcome?: string | null
          delta: number
          eas_attestation_id?: string | null
          economic_impact_usdc?: number | null
          ecosystem_need_weight?: number | null
          event_type: string
          hal_decision?: string | null
          hal_score?: number | null
          hallucination_caught?: boolean | null
          id?: number
          idempotency_key?: string | null
          information_parity?: number | null
          llm_call_id?: string | null
          llm_model?: string | null
          llm_provider?: string | null
          metadata?: Json | null
          mirror_test_triggered?: boolean | null
          prompt_text?: string | null
          repid_after: number
          repid_before: number
          repid_delta_applied?: number | null
          repid_delta_calculated?: number | null
          task_domain?: string | null
          tier_used?: string | null
          vdr_count_at_event?: number | null
          veto_class?: string | null
          zk_proof_id?: string | null
          zk_proof_triggered?: boolean | null
        }
        Update: {
          agent_id?: string | null
          alignment_category?: string | null
          answer_text?: string | null
          certainty_at_claim?: number | null
          challenger_repid_at_event?: number | null
          collusion_risk?: number | null
          contract_id?: string | null
          created_at?: string | null
          decision_outcome?: string | null
          delta?: number
          eas_attestation_id?: string | null
          economic_impact_usdc?: number | null
          ecosystem_need_weight?: number | null
          event_type?: string
          hal_decision?: string | null
          hal_score?: number | null
          hallucination_caught?: boolean | null
          id?: number
          idempotency_key?: string | null
          information_parity?: number | null
          llm_call_id?: string | null
          llm_model?: string | null
          llm_provider?: string | null
          metadata?: Json | null
          mirror_test_triggered?: boolean | null
          prompt_text?: string | null
          repid_after?: number
          repid_before?: number
          repid_delta_applied?: number | null
          repid_delta_calculated?: number | null
          task_domain?: string | null
          tier_used?: string | null
          vdr_count_at_event?: number | null
          veto_class?: string | null
          zk_proof_id?: string | null
          zk_proof_triggered?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "repid_score_events_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      repid_scores: {
        Row: {
          display_name: string | null
          id: string
          identity_address: string
          identity_type: string
          last_updated: string | null
          rep_score: number | null
          score_breakdown: Json | null
        }
        Insert: {
          display_name?: string | null
          id?: string
          identity_address: string
          identity_type: string
          last_updated?: string | null
          rep_score?: number | null
          score_breakdown?: Json | null
        }
        Update: {
          display_name?: string | null
          id?: string
          identity_address?: string
          identity_type?: string
          last_updated?: string | null
          rep_score?: number | null
          score_breakdown?: Json | null
        }
        Relationships: []
      }
      repid_stakes: {
        Row: {
          agent_id: string
          created_at: string
          id: string
          stake_amount_usd: number
          status: string
          user_id: string
          withdrawn_at: string | null
        }
        Insert: {
          agent_id: string
          created_at?: string
          id?: string
          stake_amount_usd: number
          status: string
          user_id: string
          withdrawn_at?: string | null
        }
        Update: {
          agent_id?: string
          created_at?: string
          id?: string
          stake_amount_usd?: number
          status?: string
          user_id?: string
          withdrawn_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "repid_stakes_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "repid_stakes_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "repid_users"
            referencedColumns: ["id"]
          },
        ]
      }
      repid_trade_attempts: {
        Row: {
          agent_id: string
          created_at: string
          decision: string
          executed: boolean
          executed_at: string | null
          fraction_used: number
          id: string
          max_allowed_usd: number
          reason: string | null
          repid_at_decision: number
          stake_id: string | null
          trade_size_usd: number
          user_id: string
        }
        Insert: {
          agent_id: string
          created_at?: string
          decision: string
          executed?: boolean
          executed_at?: string | null
          fraction_used: number
          id?: string
          max_allowed_usd: number
          reason?: string | null
          repid_at_decision: number
          stake_id?: string | null
          trade_size_usd: number
          user_id: string
        }
        Update: {
          agent_id?: string
          created_at?: string
          decision?: string
          executed?: boolean
          executed_at?: string | null
          fraction_used?: number
          id?: string
          max_allowed_usd?: number
          reason?: string | null
          repid_at_decision?: number
          stake_id?: string | null
          trade_size_usd?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "repid_trade_attempts_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "repid_trade_attempts_stake_id_fkey"
            columns: ["stake_id"]
            isOneToOne: false
            referencedRelation: "repid_stakes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "repid_trade_attempts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "repid_users"
            referencedColumns: ["id"]
          },
        ]
      }
      repid_transactions: {
        Row: {
          agent_id: string | null
          amount: number
          bonus_type: string | null
          created_at: string | null
          id: number
          metadata: Json | null
          reason: string
          user_id: number | null
        }
        Insert: {
          agent_id?: string | null
          amount: number
          bonus_type?: string | null
          created_at?: string | null
          id?: number
          metadata?: Json | null
          reason: string
          user_id?: number | null
        }
        Update: {
          agent_id?: string | null
          amount?: number
          bonus_type?: string | null
          created_at?: string | null
          id?: number
          metadata?: Json | null
          reason?: string
          user_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "repid_transactions_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agent_health_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "repid_transactions_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "trinity_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "repid_transactions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "aidebate_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "repid_transactions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_leaderboard"
            referencedColumns: ["id"]
          },
        ]
      }
      repid_users: {
        Row: {
          created_at: string
          display_name: string | null
          id: string
          user_address: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          id?: string
          user_address: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          id?: string
          user_address?: string
        }
        Relationships: []
      }
      repid_verified_decisions: {
        Row: {
          agent_id: string | null
          created_at: string | null
          id: number
          last_verified_at: string | null
          updated_at: string | null
          vdr_count: number
        }
        Insert: {
          agent_id?: string | null
          created_at?: string | null
          id?: number
          last_verified_at?: string | null
          updated_at?: string | null
          vdr_count?: number
        }
        Update: {
          agent_id?: string | null
          created_at?: string | null
          id?: number
          last_verified_at?: string | null
          updated_at?: string | null
          vdr_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "repid_verified_decisions_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: true
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      repid_vesting_events: {
        Row: {
          agent_id: string | null
          cliff_ends_at: string
          created_at: string | null
          id: number
          repid_earned: number
          repid_vested: number | null
          vesting_complete: boolean | null
        }
        Insert: {
          agent_id?: string | null
          cliff_ends_at: string
          created_at?: string | null
          id?: number
          repid_earned: number
          repid_vested?: number | null
          vesting_complete?: boolean | null
        }
        Update: {
          agent_id?: string | null
          cliff_ends_at?: string
          created_at?: string | null
          id?: number
          repid_earned?: number
          repid_vested?: number | null
          vesting_complete?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "repid_vesting_events_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      repid_votes: {
        Row: {
          created_at: string | null
          id: string
          reason: string | null
          target_agent: string
          task_id: number | null
          vote_score: number | null
          voter_agent: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          reason?: string | null
          target_agent: string
          task_id?: number | null
          vote_score?: number | null
          voter_agent: string
        }
        Update: {
          created_at?: string | null
          id?: string
          reason?: string | null
          target_agent?: string
          task_id?: number | null
          vote_score?: number | null
          voter_agent?: string
        }
        Relationships: [
          {
            foreignKeyName: "repid_votes_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "trinity_post_task_lag"
            referencedColumns: ["task_id"]
          },
          {
            foreignKeyName: "repid_votes_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "trinity_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      repid_webhooks: {
        Row: {
          active: boolean | null
          api_key: string | null
          created_at: string | null
          events: string[] | null
          id: string
          url: string
        }
        Insert: {
          active?: boolean | null
          api_key?: string | null
          created_at?: string | null
          events?: string[] | null
          id?: string
          url: string
        }
        Update: {
          active?: boolean | null
          api_key?: string | null
          created_at?: string | null
          events?: string[] | null
          id?: string
          url?: string
        }
        Relationships: []
      }
      repid_wisdom_scores: {
        Row: {
          agent_id: string | null
          calibration_score: number | null
          composite_wisdom: number | null
          domain_transfer_score: number | null
          epistemic_humility_score: number | null
          id: number
          sample_size: number | null
          updated_at: string | null
        }
        Insert: {
          agent_id?: string | null
          calibration_score?: number | null
          composite_wisdom?: number | null
          domain_transfer_score?: number | null
          epistemic_humility_score?: number | null
          id?: number
          sample_size?: number | null
          updated_at?: string | null
        }
        Update: {
          agent_id?: string | null
          calibration_score?: number | null
          composite_wisdom?: number | null
          domain_transfer_score?: number | null
          epistemic_humility_score?: number | null
          id?: number
          sample_size?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "repid_wisdom_scores_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: true
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      repid_zkp_proofs: {
        Row: {
          agent_id: string | null
          created_at: string | null
          eas_attestation_uid: string | null
          eas_schema: string | null
          expires_at: string | null
          id: number
          merkle_root: string | null
          proof_type: string
          tier_proven: string
          zk_commitment: string | null
        }
        Insert: {
          agent_id?: string | null
          created_at?: string | null
          eas_attestation_uid?: string | null
          eas_schema?: string | null
          expires_at?: string | null
          id?: number
          merkle_root?: string | null
          proof_type: string
          tier_proven: string
          zk_commitment?: string | null
        }
        Update: {
          agent_id?: string | null
          created_at?: string | null
          eas_attestation_uid?: string | null
          eas_schema?: string | null
          expires_at?: string | null
          id?: number
          merkle_root?: string | null
          proof_type?: string
          tier_proven?: string
          zk_commitment?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "repid_zkp_proofs_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      reputation_attestations: {
        Row: {
          attestation_payload: Json
          attester_agent_id: string
          character_score_snapshot: number | null
          created_at: string
          current_repid_snapshot: number
          expires_at: string
          id: string
          patent_marker: string
          revoked_at: string | null
          service_contract_id: string
          signature: string
          signing_address: string
          subject_agent_id: string
          tier_snapshot: string
          validation_count_snapshot: number
          validations_correct_snapshot: number
          vdr_count_snapshot: number
          wisdom_score_snapshot: number | null
          zkp_proof_id: string | null
        }
        Insert: {
          attestation_payload: Json
          attester_agent_id: string
          character_score_snapshot?: number | null
          created_at?: string
          current_repid_snapshot: number
          expires_at?: string
          id?: string
          patent_marker?: string
          revoked_at?: string | null
          service_contract_id: string
          signature: string
          signing_address: string
          subject_agent_id: string
          tier_snapshot: string
          validation_count_snapshot: number
          validations_correct_snapshot: number
          vdr_count_snapshot: number
          wisdom_score_snapshot?: number | null
          zkp_proof_id?: string | null
        }
        Update: {
          attestation_payload?: Json
          attester_agent_id?: string
          character_score_snapshot?: number | null
          created_at?: string
          current_repid_snapshot?: number
          expires_at?: string
          id?: string
          patent_marker?: string
          revoked_at?: string | null
          service_contract_id?: string
          signature?: string
          signing_address?: string
          subject_agent_id?: string
          tier_snapshot?: string
          validation_count_snapshot?: number
          validations_correct_snapshot?: number
          vdr_count_snapshot?: number
          wisdom_score_snapshot?: number | null
          zkp_proof_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "reputation_attestations_attester_agent_id_fkey"
            columns: ["attester_agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reputation_attestations_service_contract_id_fkey"
            columns: ["service_contract_id"]
            isOneToOne: false
            referencedRelation: "cascade_telemetry_v1"
            referencedColumns: ["contract_id"]
          },
          {
            foreignKeyName: "reputation_attestations_service_contract_id_fkey"
            columns: ["service_contract_id"]
            isOneToOne: false
            referencedRelation: "service_contracts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reputation_attestations_service_contract_id_fkey"
            columns: ["service_contract_id"]
            isOneToOne: false
            referencedRelation: "v_cascade_baseline_2026_05_18"
            referencedColumns: ["contract_id"]
          },
          {
            foreignKeyName: "reputation_attestations_subject_agent_id_fkey"
            columns: ["subject_agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      retrieval_logs: {
        Row: {
          anfis_scores: Json | null
          artifact_id: number | null
          cost_units: number | null
          created_at: string | null
          id: number
          latency_ms: number | null
          nodes_traversed: Json | null
          query_text: string | null
          tier_used: number | null
        }
        Insert: {
          anfis_scores?: Json | null
          artifact_id?: number | null
          cost_units?: number | null
          created_at?: string | null
          id?: number
          latency_ms?: number | null
          nodes_traversed?: Json | null
          query_text?: string | null
          tier_used?: number | null
        }
        Update: {
          anfis_scores?: Json | null
          artifact_id?: number | null
          cost_units?: number | null
          created_at?: string | null
          id?: number
          latency_ms?: number | null
          nodes_traversed?: Json | null
          query_text?: string | null
          tier_used?: number | null
        }
        Relationships: []
      }
      rotation_state: {
        Row: {
          current_conductor: string
          id: number
          rotation_number: number
          rotation_time: string
        }
        Insert: {
          current_conductor?: string
          id?: number
          rotation_number?: number
          rotation_time?: string
        }
        Update: {
          current_conductor?: string
          id?: number
          rotation_number?: number
          rotation_time?: string
        }
        Relationships: []
      }
      routing_decisions: {
        Row: {
          actual_cost: number | null
          certainty: number | null
          chosen_provider: string | null
          cost: number | null
          created_at: string | null
          id: string
          impact: number | null
          latency: number | null
          task_description: string | null
          urgency: number | null
        }
        Insert: {
          actual_cost?: number | null
          certainty?: number | null
          chosen_provider?: string | null
          cost?: number | null
          created_at?: string | null
          id?: string
          impact?: number | null
          latency?: number | null
          task_description?: string | null
          urgency?: number | null
        }
        Update: {
          actual_cost?: number | null
          certainty?: number | null
          chosen_provider?: string | null
          cost?: number | null
          created_at?: string | null
          id?: string
          impact?: number | null
          latency?: number | null
          task_description?: string | null
          urgency?: number | null
        }
        Relationships: []
      }
      routing_weights: {
        Row: {
          avg_latency_ms: number | null
          circuit_open: boolean | null
          circuit_open_until: string | null
          failure_count: number | null
          id: number
          last_failure: string | null
          last_success: string | null
          provider: string
          success_count: number | null
          total_latency_ms: number | null
          updated_at: string | null
          weight: number | null
        }
        Insert: {
          avg_latency_ms?: number | null
          circuit_open?: boolean | null
          circuit_open_until?: string | null
          failure_count?: number | null
          id?: number
          last_failure?: string | null
          last_success?: string | null
          provider: string
          success_count?: number | null
          total_latency_ms?: number | null
          updated_at?: string | null
          weight?: number | null
        }
        Update: {
          avg_latency_ms?: number | null
          circuit_open?: boolean | null
          circuit_open_until?: string | null
          failure_count?: number | null
          id?: number
          last_failure?: string | null
          last_success?: string | null
          provider?: string
          success_count?: number | null
          total_latency_ms?: number | null
          updated_at?: string | null
          weight?: number | null
        }
        Relationships: []
      }
      sandbox_agent_state: {
        Row: {
          agent_id: string
          current_task: string | null
          id: string
          memory: Json | null
          status: string | null
          updated_at: string | null
        }
        Insert: {
          agent_id: string
          current_task?: string | null
          id?: string
          memory?: Json | null
          status?: string | null
          updated_at?: string | null
        }
        Update: {
          agent_id?: string
          current_task?: string | null
          id?: string
          memory?: Json | null
          status?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      sandbox_escalation_log: {
        Row: {
          created_at: string | null
          id: string
          payload: Json | null
          reason: string
          resolved: boolean | null
          source_agent: string
          target_role: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          payload?: Json | null
          reason: string
          resolved?: boolean | null
          source_agent: string
          target_role: string
        }
        Update: {
          created_at?: string | null
          id?: string
          payload?: Json | null
          reason?: string
          resolved?: boolean | null
          source_agent?: string
          target_role?: string
        }
        Relationships: []
      }
      sandbox_rag_knowledge: {
        Row: {
          content: string
          created_at: string | null
          embedding: string | null
          id: string
          metadata: Json | null
        }
        Insert: {
          content: string
          created_at?: string | null
          embedding?: string | null
          id?: string
          metadata?: Json | null
        }
        Update: {
          content?: string
          created_at?: string | null
          embedding?: string | null
          id?: string
          metadata?: Json | null
        }
        Relationships: []
      }
      sandbox_repid_credentials: {
        Row: {
          credential_type: string
          holder_did: string
          id: string
          issued_at: string | null
          verified: boolean | null
          zkp_proof: string | null
        }
        Insert: {
          credential_type: string
          holder_did: string
          id?: string
          issued_at?: string | null
          verified?: boolean | null
          zkp_proof?: string | null
        }
        Update: {
          credential_type?: string
          holder_did?: string
          id?: string
          issued_at?: string | null
          verified?: boolean | null
          zkp_proof?: string | null
        }
        Relationships: []
      }
      schema_change_proposals: {
        Row: {
          created_at: string | null
          current_phase: string | null
          description: string | null
          drift_score: number | null
          executed_at: string | null
          id: string
          proposal_type: string
          proposer_agent: string | null
          quorum_certificate: Json | null
          severity: string
          sql_command: string
          status: string | null
          votes_against: string[] | null
          votes_commit: Json | null
          votes_for: string[] | null
          votes_prepare: Json | null
          zk_weight: number | null
        }
        Insert: {
          created_at?: string | null
          current_phase?: string | null
          description?: string | null
          drift_score?: number | null
          executed_at?: string | null
          id?: string
          proposal_type: string
          proposer_agent?: string | null
          quorum_certificate?: Json | null
          severity: string
          sql_command: string
          status?: string | null
          votes_against?: string[] | null
          votes_commit?: Json | null
          votes_for?: string[] | null
          votes_prepare?: Json | null
          zk_weight?: number | null
        }
        Update: {
          created_at?: string | null
          current_phase?: string | null
          description?: string | null
          drift_score?: number | null
          executed_at?: string | null
          id?: string
          proposal_type?: string
          proposer_agent?: string | null
          quorum_certificate?: Json | null
          severity?: string
          sql_command?: string
          status?: string | null
          votes_against?: string[] | null
          votes_commit?: Json | null
          votes_for?: string[] | null
          votes_prepare?: Json | null
          zk_weight?: number | null
        }
        Relationships: []
      }
      schema_evolution: {
        Row: {
          applied_at: string | null
          applied_by: string | null
          description: string | null
          id: string
          migration_sql: string | null
          rollback_sql: string | null
          verified: boolean | null
          version: string
        }
        Insert: {
          applied_at?: string | null
          applied_by?: string | null
          description?: string | null
          id?: string
          migration_sql?: string | null
          rollback_sql?: string | null
          verified?: boolean | null
          version: string
        }
        Update: {
          applied_at?: string | null
          applied_by?: string | null
          description?: string | null
          id?: string
          migration_sql?: string | null
          rollback_sql?: string | null
          verified?: boolean | null
          version?: string
        }
        Relationships: []
      }
      semantic_cache: {
        Row: {
          created_at: string | null
          expires_at: string | null
          id: string
          provider_used: string | null
          query_embedding: string | null
          query_text: string | null
          response_text: string | null
          tokens_saved: number | null
        }
        Insert: {
          created_at?: string | null
          expires_at?: string | null
          id?: string
          provider_used?: string | null
          query_embedding?: string | null
          query_text?: string | null
          response_text?: string | null
          tokens_saved?: number | null
        }
        Update: {
          created_at?: string | null
          expires_at?: string | null
          id?: string
          provider_used?: string | null
          query_embedding?: string | null
          query_text?: string | null
          response_text?: string | null
          tokens_saved?: number | null
        }
        Relationships: []
      }
      service_categories: {
        Row: {
          base_price_ceiling_usdc_raw: number | null
          base_price_floor_usdc_raw: number
          category_name: string
          created_at: string
          description: string
          display_name: string
          patent_marker: string | null
          v1_active: boolean
        }
        Insert: {
          base_price_ceiling_usdc_raw?: number | null
          base_price_floor_usdc_raw?: number
          category_name: string
          created_at?: string
          description: string
          display_name: string
          patent_marker?: string | null
          v1_active?: boolean
        }
        Update: {
          base_price_ceiling_usdc_raw?: number | null
          base_price_floor_usdc_raw?: number
          category_name?: string
          created_at?: string
          description?: string
          display_name?: string
          patent_marker?: string | null
          v1_active?: boolean
        }
        Relationships: []
      }
      service_contracts: {
        Row: {
          agreed_price_usdc_raw: number
          buyer_agent_id: string
          buyer_satisfaction_score: number | null
          created_at: string
          dispute_panel_validation_queue_id: string | null
          dispute_verdict: string | null
          disputed_at: string | null
          escrowed_at: string | null
          expires_at: string
          fulfilled_at: string | null
          id: string
          metadata: Json | null
          payload: Json
          provider_agent_id: string
          resolved_at: string | null
          result: Json | null
          satisfied_at: string | null
          service_id: string
          settled_at: string | null
          status: string
          x402_payment_id: string | null
        }
        Insert: {
          agreed_price_usdc_raw: number
          buyer_agent_id: string
          buyer_satisfaction_score?: number | null
          created_at?: string
          dispute_panel_validation_queue_id?: string | null
          dispute_verdict?: string | null
          disputed_at?: string | null
          escrowed_at?: string | null
          expires_at?: string
          fulfilled_at?: string | null
          id?: string
          metadata?: Json | null
          payload: Json
          provider_agent_id: string
          resolved_at?: string | null
          result?: Json | null
          satisfied_at?: string | null
          service_id: string
          settled_at?: string | null
          status?: string
          x402_payment_id?: string | null
        }
        Update: {
          agreed_price_usdc_raw?: number
          buyer_agent_id?: string
          buyer_satisfaction_score?: number | null
          created_at?: string
          dispute_panel_validation_queue_id?: string | null
          dispute_verdict?: string | null
          disputed_at?: string | null
          escrowed_at?: string | null
          expires_at?: string
          fulfilled_at?: string | null
          id?: string
          metadata?: Json | null
          payload?: Json
          provider_agent_id?: string
          resolved_at?: string | null
          result?: Json | null
          satisfied_at?: string | null
          service_id?: string
          settled_at?: string | null
          status?: string
          x402_payment_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "service_contracts_buyer_agent_id_fkey"
            columns: ["buyer_agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_contracts_dispute_panel_validation_queue_id_fkey"
            columns: ["dispute_panel_validation_queue_id"]
            isOneToOne: false
            referencedRelation: "validation_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_contracts_provider_agent_id_fkey"
            columns: ["provider_agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_contracts_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "agent_services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_contracts_x402_payment_id_fkey"
            columns: ["x402_payment_id"]
            isOneToOne: false
            referencedRelation: "x402_settlements"
            referencedColumns: ["id"]
          },
        ]
      }
      shared_learnings: {
        Row: {
          agent: string
          content: string | null
          created_at: string | null
          id: string
          task_type: string | null
          title: string
          useful_count: number | null
        }
        Insert: {
          agent: string
          content?: string | null
          created_at?: string | null
          id?: string
          task_type?: string | null
          title: string
          useful_count?: number | null
        }
        Update: {
          agent?: string
          content?: string | null
          created_at?: string | null
          id?: string
          task_type?: string | null
          title?: string
          useful_count?: number | null
        }
        Relationships: []
      }
      shares: {
        Row: {
          clicks: number | null
          conversions: number | null
          created_at: string | null
          debate_id: number | null
          id: number
          platform: string | null
          repid_earned: number | null
          share_code: string
          user_id: number | null
        }
        Insert: {
          clicks?: number | null
          conversions?: number | null
          created_at?: string | null
          debate_id?: number | null
          id?: number
          platform?: string | null
          repid_earned?: number | null
          share_code: string
          user_id?: number | null
        }
        Update: {
          clicks?: number | null
          conversions?: number | null
          created_at?: string | null
          debate_id?: number | null
          id?: number
          platform?: string | null
          repid_earned?: number | null
          share_code?: string
          user_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "shares_debate_id_fkey"
            columns: ["debate_id"]
            isOneToOne: false
            referencedRelation: "active_debates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shares_debate_id_fkey"
            columns: ["debate_id"]
            isOneToOne: false
            referencedRelation: "debates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shares_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "aidebate_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shares_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_leaderboard"
            referencedColumns: ["id"]
          },
        ]
      }
      signal_accuracy_log: {
        Row: {
          confidence_at_fire: number | null
          holding_period_hours: number | null
          id: string
          logged_at: string | null
          notes: string | null
          pnl_usd: number | null
          pythagorean_dissent: number | null
          signal_fired: boolean
          signal_key: string
          trade_outcome: string | null
        }
        Insert: {
          confidence_at_fire?: number | null
          holding_period_hours?: number | null
          id?: string
          logged_at?: string | null
          notes?: string | null
          pnl_usd?: number | null
          pythagorean_dissent?: number | null
          signal_fired: boolean
          signal_key: string
          trade_outcome?: string | null
        }
        Update: {
          confidence_at_fire?: number | null
          holding_period_hours?: number | null
          id?: string
          logged_at?: string | null
          notes?: string | null
          pnl_usd?: number | null
          pythagorean_dissent?: number | null
          signal_fired?: boolean
          signal_key?: string
          trade_outcome?: string | null
        }
        Relationships: []
      }
      signal_events: {
        Row: {
          category: string | null
          created_at: string | null
          event_type: string
          id: string
          metadata: Json | null
          repid_score: number | null
          verified_user_id: string | null
          viewer_id: string | null
        }
        Insert: {
          category?: string | null
          created_at?: string | null
          event_type: string
          id?: string
          metadata?: Json | null
          repid_score?: number | null
          verified_user_id?: string | null
          viewer_id?: string | null
        }
        Update: {
          category?: string | null
          created_at?: string | null
          event_type?: string
          id?: string
          metadata?: Json | null
          repid_score?: number | null
          verified_user_id?: string | null
          viewer_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "signal_events_verified_user_id_fkey"
            columns: ["verified_user_id"]
            isOneToOne: false
            referencedRelation: "verified_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "signal_events_viewer_id_fkey"
            columns: ["viewer_id"]
            isOneToOne: false
            referencedRelation: "demo_viewers"
            referencedColumns: ["id"]
          },
        ]
      }
      signal_library: {
        Row: {
          api_endpoint: string | null
          bullish_direction: string | null
          category: string
          circle_position: number | null
          community_avg_weight: number | null
          created_at: string | null
          data_source: string | null
          default_weight: number | null
          description: string | null
          display_name: string
          id: number
          is_core: boolean | null
          signal_key: string
          times_selected: number | null
        }
        Insert: {
          api_endpoint?: string | null
          bullish_direction?: string | null
          category: string
          circle_position?: number | null
          community_avg_weight?: number | null
          created_at?: string | null
          data_source?: string | null
          default_weight?: number | null
          description?: string | null
          display_name: string
          id?: number
          is_core?: boolean | null
          signal_key: string
          times_selected?: number | null
        }
        Update: {
          api_endpoint?: string | null
          bullish_direction?: string | null
          category?: string
          circle_position?: number | null
          community_avg_weight?: number | null
          created_at?: string | null
          data_source?: string | null
          default_weight?: number | null
          description?: string | null
          display_name?: string
          id?: number
          is_core?: boolean | null
          signal_key?: string
          times_selected?: number | null
        }
        Relationships: []
      }
      signal_responses: {
        Row: {
          amount_usd: number | null
          id: number
          paper_trade_id: number | null
          responded_at: string | null
          response: string
          signal_id: number | null
          user_email: string
        }
        Insert: {
          amount_usd?: number | null
          id?: number
          paper_trade_id?: number | null
          responded_at?: string | null
          response: string
          signal_id?: number | null
          user_email: string
        }
        Update: {
          amount_usd?: number | null
          id?: number
          paper_trade_id?: number | null
          responded_at?: string | null
          response?: string
          signal_id?: number | null
          user_email?: string
        }
        Relationships: [
          {
            foreignKeyName: "signal_responses_signal_id_fkey"
            columns: ["signal_id"]
            isOneToOne: false
            referencedRelation: "hal_signals"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_verifications: {
        Row: {
          account_id: string
          attempts: number | null
          created_at: string
          expires_at: string
          id: string
          phone_number: string
          received_at: string | null
          status: string
          twilio_message_sid: string | null
          updated_at: string
          user_id: string
          verification_code: string | null
        }
        Insert: {
          account_id: string
          attempts?: number | null
          created_at?: string
          expires_at?: string
          id?: string
          phone_number: string
          received_at?: string | null
          status?: string
          twilio_message_sid?: string | null
          updated_at?: string
          user_id: string
          verification_code?: string | null
        }
        Update: {
          account_id?: string
          attempts?: number | null
          created_at?: string
          expires_at?: string
          id?: string
          phone_number?: string
          received_at?: string | null
          status?: string
          twilio_message_sid?: string | null
          updated_at?: string
          user_id?: string
          verification_code?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sms_verifications_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "social_media_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      social_content_queue: {
        Row: {
          content: string | null
          created_at: string | null
          engagement_notes: string | null
          hashtags: string | null
          id: number
          media_url: string | null
          platform: string | null
          post_url: string | null
          posted_at: string | null
          scheduled_for: string | null
          status: string | null
        }
        Insert: {
          content?: string | null
          created_at?: string | null
          engagement_notes?: string | null
          hashtags?: string | null
          id?: number
          media_url?: string | null
          platform?: string | null
          post_url?: string | null
          posted_at?: string | null
          scheduled_for?: string | null
          status?: string | null
        }
        Update: {
          content?: string | null
          created_at?: string | null
          engagement_notes?: string | null
          hashtags?: string | null
          id?: number
          media_url?: string | null
          platform?: string | null
          post_url?: string | null
          posted_at?: string | null
          scheduled_for?: string | null
          status?: string | null
        }
        Relationships: []
      }
      social_media_accounts: {
        Row: {
          account_email: string
          account_username: string | null
          auth_tokens: Json | null
          created_at: string
          encrypted_password: string
          id: string
          last_login_at: string | null
          metadata: Json | null
          phone_number: string | null
          platform_id: string
          setup_status: string
          updated_at: string
          user_id: string
          verification_status: string
        }
        Insert: {
          account_email: string
          account_username?: string | null
          auth_tokens?: Json | null
          created_at?: string
          encrypted_password: string
          id?: string
          last_login_at?: string | null
          metadata?: Json | null
          phone_number?: string | null
          platform_id: string
          setup_status?: string
          updated_at?: string
          user_id: string
          verification_status?: string
        }
        Update: {
          account_email?: string
          account_username?: string | null
          auth_tokens?: Json | null
          created_at?: string
          encrypted_password?: string
          id?: string
          last_login_at?: string | null
          metadata?: Json | null
          phone_number?: string | null
          platform_id?: string
          setup_status?: string
          updated_at?: string
          user_id?: string
          verification_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_media_accounts_platform_id_fkey"
            columns: ["platform_id"]
            isOneToOne: false
            referencedRelation: "social_media_platforms"
            referencedColumns: ["id"]
          },
        ]
      }
      social_media_platforms: {
        Row: {
          api_endpoint: string | null
          created_at: string
          display_name: string
          icon_url: string | null
          id: string
          name: string
          requires_payment: boolean | null
          requires_phone: boolean | null
          signup_url: string | null
          updated_at: string
        }
        Insert: {
          api_endpoint?: string | null
          created_at?: string
          display_name: string
          icon_url?: string | null
          id?: string
          name: string
          requires_payment?: boolean | null
          requires_phone?: boolean | null
          signup_url?: string | null
          updated_at?: string
        }
        Update: {
          api_endpoint?: string | null
          created_at?: string
          display_name?: string
          icon_url?: string | null
          id?: string
          name?: string
          requires_payment?: boolean | null
          requires_phone?: boolean | null
          signup_url?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      social_mirror_analyses: {
        Row: {
          agent: string | null
          certainty: number | null
          created_at: string | null
          eq_score: number | null
          feedback_at: string | null
          feedback_comment: string | null
          feedback_resonance: number | null
          id: string
          input_text: string
          iq_score: number | null
          latency_ms: number | null
          mirror_type: string | null
          provider: string | null
          request_id: string | null
          result: string | null
          sharing_level: string | null
          sq_score: number | null
          updated_at: string | null
        }
        Insert: {
          agent?: string | null
          certainty?: number | null
          created_at?: string | null
          eq_score?: number | null
          feedback_at?: string | null
          feedback_comment?: string | null
          feedback_resonance?: number | null
          id?: string
          input_text: string
          iq_score?: number | null
          latency_ms?: number | null
          mirror_type?: string | null
          provider?: string | null
          request_id?: string | null
          result?: string | null
          sharing_level?: string | null
          sq_score?: number | null
          updated_at?: string | null
        }
        Update: {
          agent?: string | null
          certainty?: number | null
          created_at?: string | null
          eq_score?: number | null
          feedback_at?: string | null
          feedback_comment?: string | null
          feedback_resonance?: number | null
          id?: string
          input_text?: string
          iq_score?: number | null
          latency_ms?: number | null
          mirror_type?: string | null
          provider?: string | null
          request_id?: string | null
          result?: string | null
          sharing_level?: string | null
          sq_score?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      sprint_queue: {
        Row: {
          acceptance_criteria: string | null
          assigned_agent: string
          backlog_ref: string | null
          blocks: number[] | null
          claimed_at: string | null
          claimed_by: string | null
          completed_at: string | null
          created_at: string | null
          depends_on: number[] | null
          deploy_url: string | null
          description: string
          errors: string | null
          estimated_hours: number | null
          hackathon_ref: string | null
          id: number
          outcome: string | null
          patent_ref: string | null
          priority: number
          prompt_text: string | null
          repo: string | null
          repo_path: string | null
          source: string | null
          sprint_id: string
          sprint_type: string
          started_at: string | null
          status: string
          title: string
          updated_at: string | null
          verification_commands: string | null
        }
        Insert: {
          acceptance_criteria?: string | null
          assigned_agent: string
          backlog_ref?: string | null
          blocks?: number[] | null
          claimed_at?: string | null
          claimed_by?: string | null
          completed_at?: string | null
          created_at?: string | null
          depends_on?: number[] | null
          deploy_url?: string | null
          description: string
          errors?: string | null
          estimated_hours?: number | null
          hackathon_ref?: string | null
          id?: number
          outcome?: string | null
          patent_ref?: string | null
          priority?: number
          prompt_text?: string | null
          repo?: string | null
          repo_path?: string | null
          source?: string | null
          sprint_id?: string
          sprint_type?: string
          started_at?: string | null
          status?: string
          title: string
          updated_at?: string | null
          verification_commands?: string | null
        }
        Update: {
          acceptance_criteria?: string | null
          assigned_agent?: string
          backlog_ref?: string | null
          blocks?: number[] | null
          claimed_at?: string | null
          claimed_by?: string | null
          completed_at?: string | null
          created_at?: string | null
          depends_on?: number[] | null
          deploy_url?: string | null
          description?: string
          errors?: string | null
          estimated_hours?: number | null
          hackathon_ref?: string | null
          id?: number
          outcome?: string | null
          patent_ref?: string | null
          priority?: number
          prompt_text?: string | null
          repo?: string | null
          repo_path?: string | null
          source?: string | null
          sprint_id?: string
          sprint_type?: string
          started_at?: string | null
          status?: string
          title?: string
          updated_at?: string | null
          verification_commands?: string | null
        }
        Relationships: []
      }
      sprint_reports: {
        Row: {
          agent_name: string | null
          content: Json | null
          created_at: string | null
          id: number
          metadata: Json | null
          report_type: string | null
        }
        Insert: {
          agent_name?: string | null
          content?: Json | null
          created_at?: string | null
          id?: number
          metadata?: Json | null
          report_type?: string | null
        }
        Update: {
          agent_name?: string | null
          content?: Json | null
          created_at?: string | null
          id?: number
          metadata?: Json | null
          report_type?: string | null
        }
        Relationships: []
      }
      sprint_updates: {
        Row: {
          agent_id: string
          created_at: string | null
          data: Json | null
          id: number
          update_type: string
        }
        Insert: {
          agent_id: string
          created_at?: string | null
          data?: Json | null
          id?: number
          update_type: string
        }
        Update: {
          agent_id?: string
          created_at?: string | null
          data?: Json | null
          id?: number
          update_type?: string
        }
        Relationships: []
      }
      stake_authority_snapshots: {
        Row: {
          authority: number
          basis: Json
          builder_id: string
          created_at: string
          id: string
          stake_total: number
        }
        Insert: {
          authority: number
          basis: Json
          builder_id: string
          created_at?: string
          id?: string
          stake_total: number
        }
        Update: {
          authority?: number
          basis?: Json
          builder_id?: string
          created_at?: string
          id?: string
          stake_total?: number
        }
        Relationships: [
          {
            foreignKeyName: "stake_authority_snapshots_builder_id_fkey"
            columns: ["builder_id"]
            isOneToOne: false
            referencedRelation: "builders"
            referencedColumns: ["id"]
          },
        ]
      }
      stake_deposits: {
        Row: {
          amount: number
          asset: string
          builder_id: string
          created_at: string
          deposit_tx_hash: string | null
          id: string
          is_simulated: boolean
          status: string
          tx_hash: string | null
        }
        Insert: {
          amount: number
          asset?: string
          builder_id: string
          created_at?: string
          deposit_tx_hash?: string | null
          id?: string
          is_simulated?: boolean
          status?: string
          tx_hash?: string | null
        }
        Update: {
          amount?: number
          asset?: string
          builder_id?: string
          created_at?: string
          deposit_tx_hash?: string | null
          id?: string
          is_simulated?: boolean
          status?: string
          tx_hash?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stake_deposits_builder_id_fkey"
            columns: ["builder_id"]
            isOneToOne: false
            referencedRelation: "builders"
            referencedColumns: ["id"]
          },
        ]
      }
      stewardship_relationships: {
        Row: {
          backed_agent_id: string
          backed_user_id: string | null
          created_at: string | null
          erc8004_backed_token_id: string | null
          erc8004_steward_token_id: string | null
          grace_period_expires_at: string | null
          id: number
          repid_slashed: number | null
          slash_events: number | null
          status: string | null
          steward_repid_score: number
          steward_repid_staked: number
          steward_user_id: string | null
          tier: string | null
          total_yield_earned: number | null
          updated_at: string | null
          yield_rate: number | null
          zkp_proof_hash: string | null
        }
        Insert: {
          backed_agent_id: string
          backed_user_id?: string | null
          created_at?: string | null
          erc8004_backed_token_id?: string | null
          erc8004_steward_token_id?: string | null
          grace_period_expires_at?: string | null
          id?: never
          repid_slashed?: number | null
          slash_events?: number | null
          status?: string | null
          steward_repid_score: number
          steward_repid_staked: number
          steward_user_id?: string | null
          tier?: string | null
          total_yield_earned?: number | null
          updated_at?: string | null
          yield_rate?: number | null
          zkp_proof_hash?: string | null
        }
        Update: {
          backed_agent_id?: string
          backed_user_id?: string | null
          created_at?: string | null
          erc8004_backed_token_id?: string | null
          erc8004_steward_token_id?: string | null
          grace_period_expires_at?: string | null
          id?: never
          repid_slashed?: number | null
          slash_events?: number | null
          status?: string | null
          steward_repid_score?: number
          steward_repid_staked?: number
          steward_user_id?: string | null
          tier?: string | null
          total_yield_earned?: number | null
          updated_at?: string | null
          yield_rate?: number | null
          zkp_proof_hash?: string | null
        }
        Relationships: []
      }
      storage_contracts: {
        Row: {
          bucket_name: string
          buyer_agent_id: string
          content_hash: string
          content_size_bytes: number
          created_at: string
          deleted_at: string | null
          id: string
          last_retrieved_at: string | null
          metadata: Json | null
          mime_type: string | null
          provider_agent_id: string
          retention_until: string | null
          retrieval_count: number
          service_contract_id: string
          storage_path: string
        }
        Insert: {
          bucket_name?: string
          buyer_agent_id: string
          content_hash: string
          content_size_bytes: number
          created_at?: string
          deleted_at?: string | null
          id?: string
          last_retrieved_at?: string | null
          metadata?: Json | null
          mime_type?: string | null
          provider_agent_id: string
          retention_until?: string | null
          retrieval_count?: number
          service_contract_id: string
          storage_path: string
        }
        Update: {
          bucket_name?: string
          buyer_agent_id?: string
          content_hash?: string
          content_size_bytes?: number
          created_at?: string
          deleted_at?: string | null
          id?: string
          last_retrieved_at?: string | null
          metadata?: Json | null
          mime_type?: string | null
          provider_agent_id?: string
          retention_until?: string | null
          retrieval_count?: number
          service_contract_id?: string
          storage_path?: string
        }
        Relationships: [
          {
            foreignKeyName: "storage_contracts_buyer_agent_id_fkey"
            columns: ["buyer_agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "storage_contracts_provider_agent_id_fkey"
            columns: ["provider_agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "storage_contracts_service_contract_id_fkey"
            columns: ["service_contract_id"]
            isOneToOne: false
            referencedRelation: "cascade_telemetry_v1"
            referencedColumns: ["contract_id"]
          },
          {
            foreignKeyName: "storage_contracts_service_contract_id_fkey"
            columns: ["service_contract_id"]
            isOneToOne: false
            referencedRelation: "service_contracts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "storage_contracts_service_contract_id_fkey"
            columns: ["service_contract_id"]
            isOneToOne: false
            referencedRelation: "v_cascade_baseline_2026_05_18"
            referencedColumns: ["contract_id"]
          },
        ]
      }
      stripe_products: {
        Row: {
          created_at: string | null
          id: number
          monthly_price_cents: number
          stripe_price_id: string
          stripe_product_id: string
          tier_name: string
        }
        Insert: {
          created_at?: string | null
          id?: never
          monthly_price_cents: number
          stripe_price_id: string
          stripe_product_id: string
          tier_name: string
        }
        Update: {
          created_at?: string | null
          id?: never
          monthly_price_cents?: number
          stripe_price_id?: string
          stripe_product_id?: string
          tier_name?: string
        }
        Relationships: []
      }
      substance_gate_events: {
        Row: {
          agent_name: string
          char_count: number
          composite_score: number | null
          content_hash: string
          created_at: string | null
          failure_reasons: string[] | null
          id: string
          judge_confidence: number | null
          judge_verdict: string | null
          metadata: Json | null
          passed: boolean
          pcp_score: number | null
          reap_count: number | null
          result_excerpt: string
          signal_artifact_passed: boolean
          signal_char_passed: boolean
          signal_noop_passed: boolean
          signal_wrapper_passed: boolean
          task_id: number
          task_tier: string | null
        }
        Insert: {
          agent_name: string
          char_count: number
          composite_score?: number | null
          content_hash: string
          created_at?: string | null
          failure_reasons?: string[] | null
          id?: string
          judge_confidence?: number | null
          judge_verdict?: string | null
          metadata?: Json | null
          passed: boolean
          pcp_score?: number | null
          reap_count?: number | null
          result_excerpt: string
          signal_artifact_passed: boolean
          signal_char_passed: boolean
          signal_noop_passed: boolean
          signal_wrapper_passed: boolean
          task_id: number
          task_tier?: string | null
        }
        Update: {
          agent_name?: string
          char_count?: number
          composite_score?: number | null
          content_hash?: string
          created_at?: string | null
          failure_reasons?: string[] | null
          id?: string
          judge_confidence?: number | null
          judge_verdict?: string | null
          metadata?: Json | null
          passed?: boolean
          pcp_score?: number | null
          reap_count?: number | null
          result_excerpt?: string
          signal_artifact_passed?: boolean
          signal_char_passed?: boolean
          signal_noop_passed?: boolean
          signal_wrapper_passed?: boolean
          task_id?: number
          task_tier?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "substance_gate_events_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "trinity_post_task_lag"
            referencedColumns: ["task_id"]
          },
          {
            foreignKeyName: "substance_gate_events_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "trinity_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      supabase_schema_baseline: {
        Row: {
          captured_at: string | null
          column_name: string | null
          data_type: string | null
          id: number
          schema_hash: string | null
          table_name: string | null
        }
        Insert: {
          captured_at?: string | null
          column_name?: string | null
          data_type?: string | null
          id?: number
          schema_hash?: string | null
          table_name?: string | null
        }
        Update: {
          captured_at?: string | null
          column_name?: string | null
          data_type?: string | null
          id?: number
          schema_hash?: string | null
          table_name?: string | null
        }
        Relationships: []
      }
      swarm_challenges: {
        Row: {
          assigned_agent: string | null
          challenge_text: string
          challenger_email: string | null
          challenger_name: string
          claimed_at: string | null
          completed_at: string | null
          created_at: string | null
          ethics_check: Json | null
          generated_invite_code: string | null
          id: string
          invite_generated: boolean | null
          priority: number | null
          progress_percent: number | null
          result_preview: string | null
          result_url: string | null
          session_id: string | null
          status: string | null
          viewer_id: string | null
        }
        Insert: {
          assigned_agent?: string | null
          challenge_text: string
          challenger_email?: string | null
          challenger_name: string
          claimed_at?: string | null
          completed_at?: string | null
          created_at?: string | null
          ethics_check?: Json | null
          generated_invite_code?: string | null
          id?: string
          invite_generated?: boolean | null
          priority?: number | null
          progress_percent?: number | null
          result_preview?: string | null
          result_url?: string | null
          session_id?: string | null
          status?: string | null
          viewer_id?: string | null
        }
        Update: {
          assigned_agent?: string | null
          challenge_text?: string
          challenger_email?: string | null
          challenger_name?: string
          claimed_at?: string | null
          completed_at?: string | null
          created_at?: string | null
          ethics_check?: Json | null
          generated_invite_code?: string | null
          id?: string
          invite_generated?: boolean | null
          priority?: number | null
          progress_percent?: number | null
          result_preview?: string | null
          result_url?: string | null
          session_id?: string | null
          status?: string | null
          viewer_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "swarm_challenges_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "demo_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "swarm_challenges_viewer_id_fkey"
            columns: ["viewer_id"]
            isOneToOne: false
            referencedRelation: "demo_viewers"
            referencedColumns: ["id"]
          },
        ]
      }
      symphony_commands: {
        Row: {
          created_at: string
          id: string
          payload: Json | null
          processed: boolean | null
          source: string
          timestamp: string
          type: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          payload?: Json | null
          processed?: boolean | null
          source?: string
          timestamp?: string
          type: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          payload?: Json | null
          processed?: boolean | null
          source?: string
          timestamp?: string
          type?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      sync_config: {
        Row: {
          created_at: string | null
          id: string
          last_sync_at: string | null
          sync_enabled: boolean | null
          target_anon_key: string | null
          target_supabase_url: string
        }
        Insert: {
          created_at?: string | null
          id: string
          last_sync_at?: string | null
          sync_enabled?: boolean | null
          target_anon_key?: string | null
          target_supabase_url: string
        }
        Update: {
          created_at?: string | null
          id?: string
          last_sync_at?: string | null
          sync_enabled?: boolean | null
          target_anon_key?: string | null
          target_supabase_url?: string
        }
        Relationships: []
      }
      sync_queue: {
        Row: {
          attempted_at: string | null
          attempts: number | null
          completed_at: string | null
          created_at: string | null
          error_message: string | null
          id: number
          max_attempts: number | null
          payload: Json
          priority: number | null
          requested_by: string | null
          status: string | null
          sync_type: string
        }
        Insert: {
          attempted_at?: string | null
          attempts?: number | null
          completed_at?: string | null
          created_at?: string | null
          error_message?: string | null
          id?: number
          max_attempts?: number | null
          payload: Json
          priority?: number | null
          requested_by?: string | null
          status?: string | null
          sync_type: string
        }
        Update: {
          attempted_at?: string | null
          attempts?: number | null
          completed_at?: string | null
          created_at?: string | null
          error_message?: string | null
          id?: number
          max_attempts?: number | null
          payload?: Json
          priority?: number | null
          requested_by?: string | null
          status?: string | null
          sync_type?: string
        }
        Relationships: []
      }
      system_broadcasts: {
        Row: {
          acknowledgments: Json | null
          broadcast_type: string
          content: Json
          created_at: string | null
          expires_at: string | null
          id: number
          priority: number | null
          requires_acknowledgment: boolean | null
          source_id: string
          source_repid: number | null
          source_type: string
          status: string | null
          superseded_by: number | null
          target_conductors: string[] | null
          target_scope: string
          title: string
        }
        Insert: {
          acknowledgments?: Json | null
          broadcast_type: string
          content: Json
          created_at?: string | null
          expires_at?: string | null
          id?: number
          priority?: number | null
          requires_acknowledgment?: boolean | null
          source_id: string
          source_repid?: number | null
          source_type: string
          status?: string | null
          superseded_by?: number | null
          target_conductors?: string[] | null
          target_scope?: string
          title: string
        }
        Update: {
          acknowledgments?: Json | null
          broadcast_type?: string
          content?: Json
          created_at?: string | null
          expires_at?: string | null
          id?: number
          priority?: number | null
          requires_acknowledgment?: boolean | null
          source_id?: string
          source_repid?: number | null
          source_type?: string
          status?: string | null
          superseded_by?: number | null
          target_conductors?: string[] | null
          target_scope?: string
          title?: string
        }
        Relationships: []
      }
      system_docs: {
        Row: {
          category: string
          content: string
          created_at: string | null
          github_url: string
          id: string
          last_synced: string | null
          updated_at: string | null
          version: number | null
        }
        Insert: {
          category: string
          content: string
          created_at?: string | null
          github_url: string
          id: string
          last_synced?: string | null
          updated_at?: string | null
          version?: number | null
        }
        Update: {
          category?: string
          content?: string
          created_at?: string | null
          github_url?: string
          id?: string
          last_synced?: string | null
          updated_at?: string | null
          version?: number | null
        }
        Relationships: []
      }
      system_health: {
        Row: {
          auto_fix_applied_by: string | null
          component: string
          confidence: number | null
          details: Json | null
          fix_txid: string | null
          id: string
          last_check: string | null
          status: string | null
        }
        Insert: {
          auto_fix_applied_by?: string | null
          component: string
          confidence?: number | null
          details?: Json | null
          fix_txid?: string | null
          id?: string
          last_check?: string | null
          status?: string | null
        }
        Update: {
          auto_fix_applied_by?: string | null
          component?: string
          confidence?: number | null
          details?: Json | null
          fix_txid?: string | null
          id?: string
          last_check?: string | null
          status?: string | null
        }
        Relationships: []
      }
      system_learning_log: {
        Row: {
          action_taken: string | null
          description: string
          evidence: string | null
          id: string
          learning_type: string
          logged_at: string | null
          logged_by: string
          metric_after: number | null
          metric_before: number | null
          next_experiment: string | null
        }
        Insert: {
          action_taken?: string | null
          description: string
          evidence?: string | null
          id?: string
          learning_type: string
          logged_at?: string | null
          logged_by?: string
          metric_after?: number | null
          metric_before?: number | null
          next_experiment?: string | null
        }
        Update: {
          action_taken?: string | null
          description?: string
          evidence?: string | null
          id?: string
          learning_type?: string
          logged_at?: string | null
          logged_by?: string
          metric_after?: number | null
          metric_before?: number | null
          next_experiment?: string | null
        }
        Relationships: []
      }
      system_metrics_daily: {
        Row: {
          agent_tasks_completed: number
          agent_tasks_pending: number
          agents_online: number
          avg_task_completion_mins: number | null
          best_signal_combo: string | null
          community_waitlist_size: number
          daily_catch_velocity: number | null
          date: string
          dbt_to_sbt_conversions: number
          donors_today: number
          edge_function_errors_24h: number
          estimated_impressions: number
          hallucination_catches_today: number
          hallucination_catches_total: number
          hhem_score_avg: number | null
          id: string
          max_drawdown_pct: number
          paper_trades_today: number
          paper_trades_total: number
          pnl_today_usd: number
          pnl_total_usd: number
          pythagorean_veto_rate_pct: number | null
          recorded_at: string | null
          rep_id_events_today: number
          share_cards_generated: number
          sharpe_ratio: number | null
          signal_accuracy_by_key: Json | null
          supabase_requests_24h: number | null
          system_flood_cancelled: number
          total_donated_usd: number
          veto_saves_usd: number | null
          vouches_created: number
          win_rate_pct: number | null
          worst_signal_combo: string | null
          x_posts_made: number
        }
        Insert: {
          agent_tasks_completed?: number
          agent_tasks_pending?: number
          agents_online?: number
          avg_task_completion_mins?: number | null
          best_signal_combo?: string | null
          community_waitlist_size?: number
          daily_catch_velocity?: number | null
          date?: string
          dbt_to_sbt_conversions?: number
          donors_today?: number
          edge_function_errors_24h?: number
          estimated_impressions?: number
          hallucination_catches_today?: number
          hallucination_catches_total?: number
          hhem_score_avg?: number | null
          id?: string
          max_drawdown_pct?: number
          paper_trades_today?: number
          paper_trades_total?: number
          pnl_today_usd?: number
          pnl_total_usd?: number
          pythagorean_veto_rate_pct?: number | null
          recorded_at?: string | null
          rep_id_events_today?: number
          share_cards_generated?: number
          sharpe_ratio?: number | null
          signal_accuracy_by_key?: Json | null
          supabase_requests_24h?: number | null
          system_flood_cancelled?: number
          total_donated_usd?: number
          veto_saves_usd?: number | null
          vouches_created?: number
          win_rate_pct?: number | null
          worst_signal_combo?: string | null
          x_posts_made?: number
        }
        Update: {
          agent_tasks_completed?: number
          agent_tasks_pending?: number
          agents_online?: number
          avg_task_completion_mins?: number | null
          best_signal_combo?: string | null
          community_waitlist_size?: number
          daily_catch_velocity?: number | null
          date?: string
          dbt_to_sbt_conversions?: number
          donors_today?: number
          edge_function_errors_24h?: number
          estimated_impressions?: number
          hallucination_catches_today?: number
          hallucination_catches_total?: number
          hhem_score_avg?: number | null
          id?: string
          max_drawdown_pct?: number
          paper_trades_today?: number
          paper_trades_total?: number
          pnl_today_usd?: number
          pnl_total_usd?: number
          pythagorean_veto_rate_pct?: number | null
          recorded_at?: string | null
          rep_id_events_today?: number
          share_cards_generated?: number
          sharpe_ratio?: number | null
          signal_accuracy_by_key?: Json | null
          supabase_requests_24h?: number | null
          system_flood_cancelled?: number
          total_donated_usd?: number
          veto_saves_usd?: number | null
          vouches_created?: number
          win_rate_pct?: number | null
          worst_signal_combo?: string | null
          x_posts_made?: number
        }
        Relationships: []
      }
      system_snapshots: {
        Row: {
          created_at: string | null
          id: number
          share_url: string | null
          snapshot_data: Json | null
          view_count: number | null
        }
        Insert: {
          created_at?: string | null
          id?: number
          share_url?: string | null
          snapshot_data?: Json | null
          view_count?: number | null
        }
        Update: {
          created_at?: string | null
          id?: number
          share_url?: string | null
          snapshot_data?: Json | null
          view_count?: number | null
        }
        Relationships: []
      }
      system_truth: {
        Row: {
          changed_at: string | null
          metric_key: string
          metric_value: string
          previous_value: string | null
          verified_at: string | null
          verified_by: string
        }
        Insert: {
          changed_at?: string | null
          metric_key: string
          metric_value: string
          previous_value?: string | null
          verified_at?: string | null
          verified_by: string
        }
        Update: {
          changed_at?: string | null
          metric_key?: string
          metric_value?: string
          previous_value?: string | null
          verified_at?: string | null
          verified_by?: string
        }
        Relationships: []
      }
      task_outputs: {
        Row: {
          created_at: string | null
          file_path: string
          file_size: number | null
          file_type: string
          id: number
          task_id: number | null
        }
        Insert: {
          created_at?: string | null
          file_path: string
          file_size?: number | null
          file_type: string
          id?: number
          task_id?: number | null
        }
        Update: {
          created_at?: string | null
          file_path?: string
          file_size?: number | null
          file_type?: string
          id?: number
          task_id?: number | null
        }
        Relationships: []
      }
      task_verification_stakes: {
        Row: {
          agent_id: string | null
          created_at: string | null
          delta: number | null
          id: number
          outcome: string | null
          reasoning: string | null
          role: string | null
          stake_amount: number | null
          task_id: number | null
        }
        Insert: {
          agent_id?: string | null
          created_at?: string | null
          delta?: number | null
          id?: number
          outcome?: string | null
          reasoning?: string | null
          role?: string | null
          stake_amount?: number | null
          task_id?: number | null
        }
        Update: {
          agent_id?: string | null
          created_at?: string | null
          delta?: number | null
          id?: number
          outcome?: string | null
          reasoning?: string | null
          role?: string | null
          stake_amount?: number | null
          task_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "task_verification_stakes_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_verification_stakes_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "trinity_post_task_lag"
            referencedColumns: ["task_id"]
          },
          {
            foreignKeyName: "task_verification_stakes_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "trinity_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      task_verifications: {
        Row: {
          confidence: number | null
          created_at: string | null
          id: number
          notes: string | null
          task_id: number | null
          verification_score: number | null
          verifier_agent: string
        }
        Insert: {
          confidence?: number | null
          created_at?: string | null
          id?: number
          notes?: string | null
          task_id?: number | null
          verification_score?: number | null
          verifier_agent: string
        }
        Update: {
          confidence?: number | null
          created_at?: string | null
          id?: number
          notes?: string | null
          task_id?: number | null
          verification_score?: number | null
          verifier_agent?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_verifications_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "trinity_post_task_lag"
            referencedColumns: ["task_id"]
          },
          {
            foreignKeyName: "task_verifications_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "trinity_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      tasks: {
        Row: {
          assigned_agent: string | null
          claimed_at: string | null
          completed_at: string | null
          created_at: string | null
          description: string | null
          estimated_time: number | null
          id: string
          priority: number | null
          required_capabilities: string[] | null
          result: Json | null
          status: string | null
          title: string
          unity_score: number | null
        }
        Insert: {
          assigned_agent?: string | null
          claimed_at?: string | null
          completed_at?: string | null
          created_at?: string | null
          description?: string | null
          estimated_time?: number | null
          id?: string
          priority?: number | null
          required_capabilities?: string[] | null
          result?: Json | null
          status?: string | null
          title: string
          unity_score?: number | null
        }
        Update: {
          assigned_agent?: string | null
          claimed_at?: string | null
          completed_at?: string | null
          created_at?: string | null
          description?: string | null
          estimated_time?: number | null
          id?: string
          priority?: number | null
          required_capabilities?: string[] | null
          result?: Json | null
          status?: string | null
          title?: string
          unity_score?: number | null
        }
        Relationships: []
      }
      tax_events: {
        Row: {
          action: string
          amount_usd: number | null
          asset: string
          created_at: string | null
          decision_type: string | null
          harvest_notes: string | null
          id: number
          is_tax_harvest: boolean | null
          jurisdiction: string | null
          pnl_usd: number | null
          price_at_trade: number | null
          trade_date: string
          unity_score: number | null
          user_nickname: string | null
        }
        Insert: {
          action: string
          amount_usd?: number | null
          asset: string
          created_at?: string | null
          decision_type?: string | null
          harvest_notes?: string | null
          id?: number
          is_tax_harvest?: boolean | null
          jurisdiction?: string | null
          pnl_usd?: number | null
          price_at_trade?: number | null
          trade_date: string
          unity_score?: number | null
          user_nickname?: string | null
        }
        Update: {
          action?: string
          amount_usd?: number | null
          asset?: string
          created_at?: string | null
          decision_type?: string | null
          harvest_notes?: string | null
          id?: number
          is_tax_harvest?: boolean | null
          jurisdiction?: string | null
          pnl_usd?: number | null
          price_at_trade?: number | null
          trade_date?: string
          unity_score?: number | null
          user_nickname?: string | null
        }
        Relationships: []
      }
      tax_harvest_signals: {
        Row: {
          asset: string
          constitutional_veto_fired: boolean | null
          created_at: string | null
          current_loss_pct: number | null
          harvest_recommended: boolean | null
          id: number
          jurisdiction: string | null
          jurisdiction_notes: string | null
          notes: string | null
          rebuy_immediately: boolean | null
          strategy_legal: boolean | null
          unrealized_loss_usd: number | null
        }
        Insert: {
          asset: string
          constitutional_veto_fired?: boolean | null
          created_at?: string | null
          current_loss_pct?: number | null
          harvest_recommended?: boolean | null
          id?: number
          jurisdiction?: string | null
          jurisdiction_notes?: string | null
          notes?: string | null
          rebuy_immediately?: boolean | null
          strategy_legal?: boolean | null
          unrealized_loss_usd?: number | null
        }
        Update: {
          asset?: string
          constitutional_veto_fired?: boolean | null
          created_at?: string | null
          current_loss_pct?: number | null
          harvest_recommended?: boolean | null
          id?: number
          jurisdiction?: string | null
          jurisdiction_notes?: string | null
          notes?: string | null
          rebuy_immediately?: boolean | null
          strategy_legal?: boolean | null
          unrealized_loss_usd?: number | null
        }
        Relationships: []
      }
      team_coordination_log: {
        Row: {
          content: string
          created_at: string | null
          id: number
          message_type: string
          posted_by: string
          related_task_id: number | null
          requires_sean_action: boolean | null
          sean_actioned: boolean | null
          sprint: string | null
        }
        Insert: {
          content: string
          created_at?: string | null
          id?: number
          message_type: string
          posted_by: string
          related_task_id?: number | null
          requires_sean_action?: boolean | null
          sean_actioned?: boolean | null
          sprint?: string | null
        }
        Update: {
          content?: string
          created_at?: string | null
          id?: number
          message_type?: string
          posted_by?: string
          related_task_id?: number | null
          requires_sean_action?: boolean | null
          sean_actioned?: boolean | null
          sprint?: string | null
        }
        Relationships: []
      }
      token_issuance_log: {
        Row: {
          agent_name: string
          conversion_from: string | null
          four_fa_method: string | null
          id: number
          issued_at: string | null
          token_id: string
          token_type: string
          zkp_proof_cid: string | null
        }
        Insert: {
          agent_name: string
          conversion_from?: string | null
          four_fa_method?: string | null
          id?: number
          issued_at?: string | null
          token_id: string
          token_type: string
          zkp_proof_cid?: string | null
        }
        Update: {
          agent_name?: string
          conversion_from?: string | null
          four_fa_method?: string | null
          id?: number
          issued_at?: string | null
          token_id?: string
          token_type?: string
          zkp_proof_cid?: string | null
        }
        Relationships: []
      }
      trade_execution_log: {
        Row: {
          action: string | null
          agent_name: string | null
          amount_usd: number | null
          asset: string
          broker: string | null
          chesed_tier: string | null
          comma_severity: string | null
          created_at: string | null
          cycle_id: string | null
          decision: string | null
          direction: string | null
          dissonance: number | null
          executed_at: string | null
          executed_price: number | null
          executed_size: number | null
          execution_mode: string
          hitl_latency_ms: number | null
          hitl_operator_id: string | null
          id: number
          merkle_hash: string | null
          notes: string | null
          nullifier: string | null
          order_type: string | null
          pair: string | null
          pnl_realized: number | null
          pnl_unrealized: number | null
          position_size_multiplier: number | null
          reason: string | null
          requested_price: number | null
          requested_size: number | null
          risk_profile: string | null
          signature: string | null
          slippage_pct: number | null
          slippage_threshold_used: number | null
          unity_score: number | null
          w3c_mode_active: boolean | null
          w3c_upgrade_triggered: boolean | null
          zk_proof: Json | null
        }
        Insert: {
          action?: string | null
          agent_name?: string | null
          amount_usd?: number | null
          asset: string
          broker?: string | null
          chesed_tier?: string | null
          comma_severity?: string | null
          created_at?: string | null
          cycle_id?: string | null
          decision?: string | null
          direction?: string | null
          dissonance?: number | null
          executed_at?: string | null
          executed_price?: number | null
          executed_size?: number | null
          execution_mode: string
          hitl_latency_ms?: number | null
          hitl_operator_id?: string | null
          id?: number
          merkle_hash?: string | null
          notes?: string | null
          nullifier?: string | null
          order_type?: string | null
          pair?: string | null
          pnl_realized?: number | null
          pnl_unrealized?: number | null
          position_size_multiplier?: number | null
          reason?: string | null
          requested_price?: number | null
          requested_size?: number | null
          risk_profile?: string | null
          signature?: string | null
          slippage_pct?: number | null
          slippage_threshold_used?: number | null
          unity_score?: number | null
          w3c_mode_active?: boolean | null
          w3c_upgrade_triggered?: boolean | null
          zk_proof?: Json | null
        }
        Update: {
          action?: string | null
          agent_name?: string | null
          amount_usd?: number | null
          asset?: string
          broker?: string | null
          chesed_tier?: string | null
          comma_severity?: string | null
          created_at?: string | null
          cycle_id?: string | null
          decision?: string | null
          direction?: string | null
          dissonance?: number | null
          executed_at?: string | null
          executed_price?: number | null
          executed_size?: number | null
          execution_mode?: string
          hitl_latency_ms?: number | null
          hitl_operator_id?: string | null
          id?: number
          merkle_hash?: string | null
          notes?: string | null
          nullifier?: string | null
          order_type?: string | null
          pair?: string | null
          pnl_realized?: number | null
          pnl_unrealized?: number | null
          position_size_multiplier?: number | null
          reason?: string | null
          requested_price?: number | null
          requested_size?: number | null
          risk_profile?: string | null
          signature?: string | null
          slippage_pct?: number | null
          slippage_threshold_used?: number | null
          unity_score?: number | null
          w3c_mode_active?: boolean | null
          w3c_upgrade_triggered?: boolean | null
          zk_proof?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "trade_execution_log_cycle_id_fkey"
            columns: ["cycle_id"]
            isOneToOne: false
            referencedRelation: "prediction_consensus"
            referencedColumns: ["cycle_id"]
          },
        ]
      }
      trading_rounds: {
        Row: {
          apm_bet_id: string | null
          created_at: string
          id: string
          oracle_endpoint: string
          resolved_at: string | null
          status: string
          veritas_bet_id: string | null
        }
        Insert: {
          apm_bet_id?: string | null
          created_at?: string
          id?: string
          oracle_endpoint: string
          resolved_at?: string | null
          status?: string
          veritas_bet_id?: string | null
        }
        Update: {
          apm_bet_id?: string | null
          created_at?: string
          id?: string
          oracle_endpoint?: string
          resolved_at?: string | null
          status?: string
          veritas_bet_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "trading_rounds_apm_bet_id_fkey"
            columns: ["apm_bet_id"]
            isOneToOne: false
            referencedRelation: "linked_bets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trading_rounds_veritas_bet_id_fkey"
            columns: ["veritas_bet_id"]
            isOneToOne: false
            referencedRelation: "linked_bets"
            referencedColumns: ["id"]
          },
        ]
      }
      trinity_access_invites: {
        Row: {
          access_level: string | null
          created_at: string | null
          created_by: string
          email: string | null
          expires_at: string | null
          id: string
          invite_code: string
          is_revoked: boolean | null
          used_at: string | null
          used_by_ip: string | null
        }
        Insert: {
          access_level?: string | null
          created_at?: string | null
          created_by: string
          email?: string | null
          expires_at?: string | null
          id?: string
          invite_code: string
          is_revoked?: boolean | null
          used_at?: string | null
          used_by_ip?: string | null
        }
        Update: {
          access_level?: string | null
          created_at?: string | null
          created_by?: string
          email?: string | null
          expires_at?: string | null
          id?: string
          invite_code?: string
          is_revoked?: boolean | null
          used_at?: string | null
          used_by_ip?: string | null
        }
        Relationships: []
      }
      trinity_access_requests: {
        Row: {
          created_at: string | null
          email: string
          id: string
          phone: string | null
          requested_resource: string | null
          social_handle: string | null
          status: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          email: string
          id?: string
          phone?: string | null
          requested_resource?: string | null
          social_handle?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          email?: string
          id?: string
          phone?: string | null
          requested_resource?: string | null
          social_handle?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      trinity_agent_benchmarks: {
        Row: {
          agent_name: string
          artifact_id: number | null
          benchmark_type: string
          created_at: string | null
          id: string
          metric_name: string
          score: number
        }
        Insert: {
          agent_name: string
          artifact_id?: number | null
          benchmark_type: string
          created_at?: string | null
          id?: string
          metric_name: string
          score: number
        }
        Update: {
          agent_name?: string
          artifact_id?: number | null
          benchmark_type?: string
          created_at?: string | null
          id?: string
          metric_name?: string
          score?: number
        }
        Relationships: [
          {
            foreignKeyName: "trinity_agent_benchmarks_artifact_id_fkey"
            columns: ["artifact_id"]
            isOneToOne: false
            referencedRelation: "trinity_artifacts"
            referencedColumns: ["id"]
          },
        ]
      }
      trinity_agent_config: {
        Row: {
          agent: string
          created_at: string | null
          full_name: string
          is_active: boolean | null
          platform: string | null
          primary_skills: string[] | null
          sabbath_day: string | null
          wallet_address: string | null
        }
        Insert: {
          agent: string
          created_at?: string | null
          full_name: string
          is_active?: boolean | null
          platform?: string | null
          primary_skills?: string[] | null
          sabbath_day?: string | null
          wallet_address?: string | null
        }
        Update: {
          agent?: string
          created_at?: string | null
          full_name?: string
          is_active?: boolean | null
          platform?: string | null
          primary_skills?: string[] | null
          sabbath_day?: string | null
          wallet_address?: string | null
        }
        Relationships: []
      }
      trinity_agent_credits: {
        Row: {
          amount: number
          created_at: string | null
          from_agent: string
          id: string
          reason: string
          settled_onchain: boolean | null
          task_id: number | null
          to_agent: string
          tx_hash: string | null
        }
        Insert: {
          amount: number
          created_at?: string | null
          from_agent: string
          id?: string
          reason: string
          settled_onchain?: boolean | null
          task_id?: number | null
          to_agent: string
          tx_hash?: string | null
        }
        Update: {
          amount?: number
          created_at?: string | null
          from_agent?: string
          id?: string
          reason?: string
          settled_onchain?: boolean | null
          task_id?: number | null
          to_agent?: string
          tx_hash?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "trinity_agent_credits_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "trinity_post_task_lag"
            referencedColumns: ["task_id"]
          },
          {
            foreignKeyName: "trinity_agent_credits_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "trinity_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      trinity_agent_directives: {
        Row: {
          active: boolean | null
          agent: string
          created_at: string | null
          directive: string
          directive_type: string
          expires_at: string | null
          id: number
          priority: number | null
        }
        Insert: {
          active?: boolean | null
          agent: string
          created_at?: string | null
          directive: string
          directive_type: string
          expires_at?: string | null
          id?: number
          priority?: number | null
        }
        Update: {
          active?: boolean | null
          agent?: string
          created_at?: string | null
          directive?: string
          directive_type?: string
          expires_at?: string | null
          id?: number
          priority?: number | null
        }
        Relationships: []
      }
      trinity_agent_genesis: {
        Row: {
          agent_name: string
          created_at: string | null
          first_task_at: string | null
          genesis_path: string
          lessons_learned: number | null
          pre_genesis_wisdom: string | null
        }
        Insert: {
          agent_name: string
          created_at?: string | null
          first_task_at?: string | null
          genesis_path: string
          lessons_learned?: number | null
          pre_genesis_wisdom?: string | null
        }
        Update: {
          agent_name?: string
          created_at?: string | null
          first_task_at?: string | null
          genesis_path?: string
          lessons_learned?: number | null
          pre_genesis_wisdom?: string | null
        }
        Relationships: []
      }
      trinity_agent_groups: {
        Row: {
          agent_name: string
          capabilities: Json | null
          cloned_from: string | null
          created_at: string | null
          description: string | null
          group_name: string
          id: string
          is_survivor: boolean | null
          llm_coordinator: string | null
        }
        Insert: {
          agent_name: string
          capabilities?: Json | null
          cloned_from?: string | null
          created_at?: string | null
          description?: string | null
          group_name: string
          id?: string
          is_survivor?: boolean | null
          llm_coordinator?: string | null
        }
        Update: {
          agent_name?: string
          capabilities?: Json | null
          cloned_from?: string | null
          created_at?: string | null
          description?: string | null
          group_name?: string
          id?: string
          is_survivor?: boolean | null
          llm_coordinator?: string | null
        }
        Relationships: []
      }
      trinity_agent_logs: {
        Row: {
          action: string | null
          agent: string
          agent_name: string | null
          artifacts: Json | null
          content: string | null
          created_at: string | null
          duration_seconds: number | null
          end_time: string | null
          error_message: string | null
          id: string
          is_evergreen: boolean | null
          loop_count: number | null
          message: string | null
          metadata: Json | null
          output_summary: string | null
          repid_impact: number | null
          start_time: string | null
          status: string | null
          task_id: number | null
          task_title: string | null
        }
        Insert: {
          action?: string | null
          agent: string
          agent_name?: string | null
          artifacts?: Json | null
          content?: string | null
          created_at?: string | null
          duration_seconds?: number | null
          end_time?: string | null
          error_message?: string | null
          id?: string
          is_evergreen?: boolean | null
          loop_count?: number | null
          message?: string | null
          metadata?: Json | null
          output_summary?: string | null
          repid_impact?: number | null
          start_time?: string | null
          status?: string | null
          task_id?: number | null
          task_title?: string | null
        }
        Update: {
          action?: string | null
          agent?: string
          agent_name?: string | null
          artifacts?: Json | null
          content?: string | null
          created_at?: string | null
          duration_seconds?: number | null
          end_time?: string | null
          error_message?: string | null
          id?: string
          is_evergreen?: boolean | null
          loop_count?: number | null
          message?: string | null
          metadata?: Json | null
          output_summary?: string | null
          repid_impact?: number | null
          start_time?: string | null
          status?: string | null
          task_id?: number | null
          task_title?: string | null
        }
        Relationships: []
      }
      trinity_agent_profiles: {
        Row: {
          agent_name: string
          collaboration_methods: string | null
          created_at: string | null
          handoff_protocols: Json | null
          id: string
          learned_knowledge: string | null
          specialties: string[] | null
          updated_at: string | null
        }
        Insert: {
          agent_name: string
          collaboration_methods?: string | null
          created_at?: string | null
          handoff_protocols?: Json | null
          id?: string
          learned_knowledge?: string | null
          specialties?: string[] | null
          updated_at?: string | null
        }
        Update: {
          agent_name?: string
          collaboration_methods?: string | null
          created_at?: string | null
          handoff_protocols?: Json | null
          id?: string
          learned_knowledge?: string | null
          specialties?: string[] | null
          updated_at?: string | null
        }
        Relationships: []
      }
      trinity_agent_registry: {
        Row: {
          agent_name: string
          current_task_summary: string | null
          current_tier: string | null
          dbt_metadata: Json | null
          directive_source: string | null
          last_active: string | null
          proof_timestamp: string | null
          repid_proof: string | null
          reputation_score: number | null
          squad: string | null
          status: string | null
          suggested_prompt: string | null
          suggestion_accepted: boolean | null
          suggestion_confidence: number | null
          suggestion_timestamp: string | null
          system_prompt: string | null
          tasks_completed: number | null
          tasks_failed: number | null
        }
        Insert: {
          agent_name: string
          current_task_summary?: string | null
          current_tier?: string | null
          dbt_metadata?: Json | null
          directive_source?: string | null
          last_active?: string | null
          proof_timestamp?: string | null
          repid_proof?: string | null
          reputation_score?: number | null
          squad?: string | null
          status?: string | null
          suggested_prompt?: string | null
          suggestion_accepted?: boolean | null
          suggestion_confidence?: number | null
          suggestion_timestamp?: string | null
          system_prompt?: string | null
          tasks_completed?: number | null
          tasks_failed?: number | null
        }
        Update: {
          agent_name?: string
          current_task_summary?: string | null
          current_tier?: string | null
          dbt_metadata?: Json | null
          directive_source?: string | null
          last_active?: string | null
          proof_timestamp?: string | null
          repid_proof?: string | null
          reputation_score?: number | null
          squad?: string | null
          status?: string | null
          suggested_prompt?: string | null
          suggestion_accepted?: boolean | null
          suggestion_confidence?: number | null
          suggestion_timestamp?: string | null
          system_prompt?: string | null
          tasks_completed?: number | null
          tasks_failed?: number | null
        }
        Relationships: []
      }
      trinity_agents: {
        Row: {
          created_at: string | null
          description: string | null
          id: string
          last_heartbeat: string | null
          llm_model: string | null
          llm_provider: string | null
          name: string
          repid_balance: number | null
          role: string
          stake_accuracy: number | null
          status: string | null
          task_prefixes: string[] | null
          tasks_completed: number | null
          tasks_failed: number | null
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          id: string
          last_heartbeat?: string | null
          llm_model?: string | null
          llm_provider?: string | null
          name: string
          repid_balance?: number | null
          role: string
          stake_accuracy?: number | null
          status?: string | null
          task_prefixes?: string[] | null
          tasks_completed?: number | null
          tasks_failed?: number | null
        }
        Update: {
          created_at?: string | null
          description?: string | null
          id?: string
          last_heartbeat?: string | null
          llm_model?: string | null
          llm_provider?: string | null
          name?: string
          repid_balance?: number | null
          role?: string
          stake_accuracy?: number | null
          status?: string | null
          task_prefixes?: string[] | null
          tasks_completed?: number | null
          tasks_failed?: number | null
        }
        Relationships: []
      }
      trinity_anfis_rules: {
        Row: {
          active: boolean | null
          conditions: Json
          created_at: string | null
          id: number
          name: string
          output: Json
          strength: number | null
        }
        Insert: {
          active?: boolean | null
          conditions: Json
          created_at?: string | null
          id?: number
          name: string
          output: Json
          strength?: number | null
        }
        Update: {
          active?: boolean | null
          conditions?: Json
          created_at?: string | null
          id?: number
          name?: string
          output?: Json
          strength?: number | null
        }
        Relationships: []
      }
      trinity_artifacts: {
        Row: {
          access_level: string | null
          agent: string
          approved_at: string | null
          approved_by: string | null
          artifact_type: string
          artifact_url: string | null
          content: string | null
          content_hash: string | null
          content_preview: string | null
          created_at: string | null
          creator_agent: string | null
          external_id: string | null
          external_url: string | null
          file_hash: string | null
          file_path: string | null
          file_size_bytes: number | null
          filename: string | null
          github_sha: string | null
          github_url: string | null
          id: number
          is_public: boolean | null
          metadata: Json | null
          mime_type: string | null
          rejection_reason: string | null
          requires_approval: boolean | null
          status: string | null
          storage_location: string
          task_id: string | null
          title: string | null
          version: number | null
          view_count: number | null
        }
        Insert: {
          access_level?: string | null
          agent?: string
          approved_at?: string | null
          approved_by?: string | null
          artifact_type?: string
          artifact_url?: string | null
          content?: string | null
          content_hash?: string | null
          content_preview?: string | null
          created_at?: string | null
          creator_agent?: string | null
          external_id?: string | null
          external_url?: string | null
          file_hash?: string | null
          file_path?: string | null
          file_size_bytes?: number | null
          filename?: string | null
          github_sha?: string | null
          github_url?: string | null
          id?: number
          is_public?: boolean | null
          metadata?: Json | null
          mime_type?: string | null
          rejection_reason?: string | null
          requires_approval?: boolean | null
          status?: string | null
          storage_location?: string
          task_id?: string | null
          title?: string | null
          version?: number | null
          view_count?: number | null
        }
        Update: {
          access_level?: string | null
          agent?: string
          approved_at?: string | null
          approved_by?: string | null
          artifact_type?: string
          artifact_url?: string | null
          content?: string | null
          content_hash?: string | null
          content_preview?: string | null
          created_at?: string | null
          creator_agent?: string | null
          external_id?: string | null
          external_url?: string | null
          file_hash?: string | null
          file_path?: string | null
          file_size_bytes?: number | null
          filename?: string | null
          github_sha?: string | null
          github_url?: string | null
          id?: number
          is_public?: boolean | null
          metadata?: Json | null
          mime_type?: string | null
          rejection_reason?: string | null
          requires_approval?: boolean | null
          status?: string | null
          storage_location?: string
          task_id?: string | null
          title?: string | null
          version?: number | null
          view_count?: number | null
        }
        Relationships: []
      }
      trinity_audit_trail_status: {
        Row: {
          assigned_agent: string | null
          created_at: string | null
          id: number
          last_attempt_at: string | null
          last_error: string | null
          on_chain_status: string | null
          priority: number | null
          receipt_id: string | null
          tx_attempts: number | null
        }
        Insert: {
          assigned_agent?: string | null
          created_at?: string | null
          id?: number
          last_attempt_at?: string | null
          last_error?: string | null
          on_chain_status?: string | null
          priority?: number | null
          receipt_id?: string | null
          tx_attempts?: number | null
        }
        Update: {
          assigned_agent?: string | null
          created_at?: string | null
          id?: number
          last_attempt_at?: string | null
          last_error?: string | null
          on_chain_status?: string | null
          priority?: number | null
          receipt_id?: string | null
          tx_attempts?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "trinity_audit_trail_status_receipt_id_fkey"
            columns: ["receipt_id"]
            isOneToOne: false
            referencedRelation: "kya_compliance_receipts"
            referencedColumns: ["receipt_id"]
          },
        ]
      }
      trinity_bids: {
        Row: {
          agent_name: string | null
          bid: Json
          created_at: string
          id: string
          score: number | null
          status: string | null
          task_id: number | null
        }
        Insert: {
          agent_name?: string | null
          bid: Json
          created_at?: string
          id?: string
          score?: number | null
          status?: string | null
          task_id?: number | null
        }
        Update: {
          agent_name?: string | null
          bid?: Json
          created_at?: string
          id?: string
          score?: number | null
          status?: string | null
          task_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "trinity_bids_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "trinity_post_task_lag"
            referencedColumns: ["task_id"]
          },
          {
            foreignKeyName: "trinity_bids_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "trinity_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      trinity_blueprints: {
        Row: {
          codename: string
          content: string
          created_at: string | null
          id: number
          name: string
          patterns_learned: Json | null
          sequence: number
          status: string | null
          unlocked_by: number | null
          updated_at: string | null
          verified_at: string | null
          verified_by: string | null
        }
        Insert: {
          codename: string
          content: string
          created_at?: string | null
          id?: number
          name: string
          patterns_learned?: Json | null
          sequence: number
          status?: string | null
          unlocked_by?: number | null
          updated_at?: string | null
          verified_at?: string | null
          verified_by?: string | null
        }
        Update: {
          codename?: string
          content?: string
          created_at?: string | null
          id?: number
          name?: string
          patterns_learned?: Json | null
          sequence?: number
          status?: string | null
          unlocked_by?: number | null
          updated_at?: string | null
          verified_at?: string | null
          verified_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "trinity_blueprints_unlocked_by_fkey"
            columns: ["unlocked_by"]
            isOneToOne: false
            referencedRelation: "trinity_blueprints"
            referencedColumns: ["id"]
          },
        ]
      }
      trinity_care_actions: {
        Row: {
          action_type: string
          actor_rep_id: string
          created_at: string | null
          id: number
          metadata: Json | null
          outcome_pending: boolean | null
          outcome_positive: boolean | null
          session_id: string | null
        }
        Insert: {
          action_type: string
          actor_rep_id?: string
          created_at?: string | null
          id?: number
          metadata?: Json | null
          outcome_pending?: boolean | null
          outcome_positive?: boolean | null
          session_id?: string | null
        }
        Update: {
          action_type?: string
          actor_rep_id?: string
          created_at?: string | null
          id?: number
          metadata?: Json | null
          outcome_pending?: boolean | null
          outcome_positive?: boolean | null
          session_id?: string | null
        }
        Relationships: []
      }
      trinity_changelog: {
        Row: {
          affected_ids: string[] | null
          change_date: string | null
          change_type: string | null
          changed_by: string | null
          description: string | null
          id: number
          rollback_sql: string | null
        }
        Insert: {
          affected_ids?: string[] | null
          change_date?: string | null
          change_type?: string | null
          changed_by?: string | null
          description?: string | null
          id?: number
          rollback_sql?: string | null
        }
        Update: {
          affected_ids?: string[] | null
          change_date?: string | null
          change_type?: string | null
          changed_by?: string | null
          description?: string | null
          id?: number
          rollback_sql?: string | null
        }
        Relationships: []
      }
      trinity_chat_messages: {
        Row: {
          body: string
          certainty_score: number | null
          context_json: Json | null
          created_at: string | null
          id: string
          recipient_agent: string | null
          response_to_id: string | null
          sender_agent: string
        }
        Insert: {
          body: string
          certainty_score?: number | null
          context_json?: Json | null
          created_at?: string | null
          id?: string
          recipient_agent?: string | null
          response_to_id?: string | null
          sender_agent: string
        }
        Update: {
          body?: string
          certainty_score?: number | null
          context_json?: Json | null
          created_at?: string | null
          id?: string
          recipient_agent?: string | null
          response_to_id?: string | null
          sender_agent?: string
        }
        Relationships: [
          {
            foreignKeyName: "trinity_chat_messages_response_to_id_fkey"
            columns: ["response_to_id"]
            isOneToOne: false
            referencedRelation: "trinity_chat_messages"
            referencedColumns: ["id"]
          },
        ]
      }
      trinity_collaborations: {
        Row: {
          created_at: string | null
          edge_type: string | null
          id: string
          metadata: Json | null
          source_agent: string
          target_agent: string
          task_id: number
          weight: number | null
        }
        Insert: {
          created_at?: string | null
          edge_type?: string | null
          id?: string
          metadata?: Json | null
          source_agent: string
          target_agent: string
          task_id: number
          weight?: number | null
        }
        Update: {
          created_at?: string | null
          edge_type?: string | null
          id?: string
          metadata?: Json | null
          source_agent?: string
          target_agent?: string
          task_id?: number
          weight?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "trinity_collaborations_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "trinity_post_task_lag"
            referencedColumns: ["task_id"]
          },
          {
            foreignKeyName: "trinity_collaborations_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "trinity_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      trinity_constitutional_violations: {
        Row: {
          agent: string
          article_violated: string
          created_at: string | null
          description: string | null
          id: number
          resolved: boolean | null
          resolved_by: string | null
          severity: string | null
        }
        Insert: {
          agent: string
          article_violated: string
          created_at?: string | null
          description?: string | null
          id?: number
          resolved?: boolean | null
          resolved_by?: string | null
          severity?: string | null
        }
        Update: {
          agent?: string
          article_violated?: string
          created_at?: string | null
          description?: string | null
          id?: number
          resolved?: boolean | null
          resolved_by?: string | null
          severity?: string | null
        }
        Relationships: []
      }
      trinity_dbt_sbt_pipeline: {
        Row: {
          assigned_agent: string | null
          biometric_verified: boolean | null
          blocker: string | null
          created_at: string | null
          dbt_token_id: string
          email_verified: boolean | null
          factors_verified: number | null
          id: number
          on_chain_explorer_url: string | null
          on_chain_tx_hash: string | null
          pol_timestamp: string | null
          sbt_token_id: string | null
          sms_verified: boolean | null
          stage: string | null
          updated_at: string | null
          wallet_address: string
          wallet_sig_verified: boolean | null
        }
        Insert: {
          assigned_agent?: string | null
          biometric_verified?: boolean | null
          blocker?: string | null
          created_at?: string | null
          dbt_token_id: string
          email_verified?: boolean | null
          factors_verified?: number | null
          id?: number
          on_chain_explorer_url?: string | null
          on_chain_tx_hash?: string | null
          pol_timestamp?: string | null
          sbt_token_id?: string | null
          sms_verified?: boolean | null
          stage?: string | null
          updated_at?: string | null
          wallet_address: string
          wallet_sig_verified?: boolean | null
        }
        Update: {
          assigned_agent?: string | null
          biometric_verified?: boolean | null
          blocker?: string | null
          created_at?: string | null
          dbt_token_id?: string
          email_verified?: boolean | null
          factors_verified?: number | null
          id?: number
          on_chain_explorer_url?: string | null
          on_chain_tx_hash?: string | null
          pol_timestamp?: string | null
          sbt_token_id?: string | null
          sms_verified?: boolean | null
          stage?: string | null
          updated_at?: string | null
          wallet_address?: string
          wallet_sig_verified?: boolean | null
        }
        Relationships: []
      }
      trinity_deployment_events: {
        Row: {
          agent_name: string | null
          commit_hash: string | null
          created_at: string | null
          details: Json | null
          detected_version: string | null
          event_type: string
          expected_version: string | null
          id: number
          source_repo: string | null
        }
        Insert: {
          agent_name?: string | null
          commit_hash?: string | null
          created_at?: string | null
          details?: Json | null
          detected_version?: string | null
          event_type: string
          expected_version?: string | null
          id?: number
          source_repo?: string | null
        }
        Update: {
          agent_name?: string | null
          commit_hash?: string | null
          created_at?: string | null
          details?: Json | null
          detected_version?: string | null
          event_type?: string
          expected_version?: string | null
          id?: number
          source_repo?: string | null
        }
        Relationships: []
      }
      trinity_deployment_manifest: {
        Row: {
          deployed_at: string | null
          deployed_by: string | null
          expected_commit: string
          expected_version: string
          id: number
          is_active: boolean | null
          notes: string | null
          rollback_commit: string | null
          source_repo: string
        }
        Insert: {
          deployed_at?: string | null
          deployed_by?: string | null
          expected_commit: string
          expected_version: string
          id?: number
          is_active?: boolean | null
          notes?: string | null
          rollback_commit?: string | null
          source_repo: string
        }
        Update: {
          deployed_at?: string | null
          deployed_by?: string | null
          expected_commit?: string
          expected_version?: string
          id?: number
          is_active?: boolean | null
          notes?: string | null
          rollback_commit?: string | null
          source_repo?: string
        }
        Relationships: []
      }
      trinity_deployments: {
        Row: {
          action_id: number | null
          agent: string
          artifact_id: number | null
          completed_at: string | null
          deployment_target: string
          deployment_url: string | null
          error_message: string | null
          id: number
          metadata: Json | null
          started_at: string | null
          status: string | null
          triggered_by: string | null
        }
        Insert: {
          action_id?: number | null
          agent: string
          artifact_id?: number | null
          completed_at?: string | null
          deployment_target: string
          deployment_url?: string | null
          error_message?: string | null
          id?: number
          metadata?: Json | null
          started_at?: string | null
          status?: string | null
          triggered_by?: string | null
        }
        Update: {
          action_id?: number | null
          agent?: string
          artifact_id?: number | null
          completed_at?: string | null
          deployment_target?: string
          deployment_url?: string | null
          error_message?: string | null
          id?: number
          metadata?: Json | null
          started_at?: string | null
          status?: string | null
          triggered_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "trinity_deployments_action_id_fkey"
            columns: ["action_id"]
            isOneToOne: false
            referencedRelation: "trinity_approval_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trinity_deployments_action_id_fkey"
            columns: ["action_id"]
            isOneToOne: false
            referencedRelation: "trinity_pending_actions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trinity_deployments_artifact_id_fkey"
            columns: ["artifact_id"]
            isOneToOne: false
            referencedRelation: "trinity_artifacts"
            referencedColumns: ["id"]
          },
        ]
      }
      trinity_ethical_flags: {
        Row: {
          created_at: string | null
          description: string | null
          flagged_by: string | null
          id: string
          issue_type: string | null
          resolved: boolean | null
          resolved_at: string | null
          severity: number | null
          source_id: string | null
          source_table: string | null
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          flagged_by?: string | null
          id?: string
          issue_type?: string | null
          resolved?: boolean | null
          resolved_at?: string | null
          severity?: number | null
          source_id?: string | null
          source_table?: string | null
        }
        Update: {
          created_at?: string | null
          description?: string | null
          flagged_by?: string | null
          id?: string
          issue_type?: string | null
          resolved?: boolean | null
          resolved_at?: string | null
          severity?: number | null
          source_id?: string | null
          source_table?: string | null
        }
        Relationships: []
      }
      trinity_evergreen_tasks: {
        Row: {
          active: boolean | null
          created_at: string | null
          description: string | null
          frequency: string | null
          id: string
          last_run: string | null
          next_run: string | null
          owner_domain: string
          priority: number | null
          task_name: string
        }
        Insert: {
          active?: boolean | null
          created_at?: string | null
          description?: string | null
          frequency?: string | null
          id?: string
          last_run?: string | null
          next_run?: string | null
          owner_domain: string
          priority?: number | null
          task_name: string
        }
        Update: {
          active?: boolean | null
          created_at?: string | null
          description?: string | null
          frequency?: string | null
          id?: string
          last_run?: string | null
          next_run?: string | null
          owner_domain?: string
          priority?: number | null
          task_name?: string
        }
        Relationships: []
      }
      trinity_evolution_log: {
        Row: {
          agent: string
          context: Json | null
          created_at: string | null
          id: number
          metric_name: string
          metric_value: number | null
        }
        Insert: {
          agent: string
          context?: Json | null
          created_at?: string | null
          id?: number
          metric_name: string
          metric_value?: number | null
        }
        Update: {
          agent?: string
          context?: Json | null
          created_at?: string | null
          id?: number
          metric_name?: string
          metric_value?: number | null
        }
        Relationships: []
      }
      trinity_evolution_vault: {
        Row: {
          agent_name: string
          created_at: string | null
          effect_score: number | null
          id: string
          insight: string | null
          intent: string | null
          metadata: Json | null
          outcome: string | null
          task_id: string | null
        }
        Insert: {
          agent_name: string
          created_at?: string | null
          effect_score?: number | null
          id?: string
          insight?: string | null
          intent?: string | null
          metadata?: Json | null
          outcome?: string | null
          task_id?: string | null
        }
        Update: {
          agent_name?: string
          created_at?: string | null
          effect_score?: number | null
          id?: string
          insight?: string | null
          intent?: string | null
          metadata?: Json | null
          outcome?: string | null
          task_id?: string | null
        }
        Relationships: []
      }
      trinity_execution_logs: {
        Row: {
          agent: string
          created_at: string | null
          id: number
          latency_ms: number | null
          model: string | null
          provider: string
          success: boolean | null
          task_id: number | null
          task_type: string | null
          tokens: number | null
        }
        Insert: {
          agent: string
          created_at?: string | null
          id?: number
          latency_ms?: number | null
          model?: string | null
          provider: string
          success?: boolean | null
          task_id?: number | null
          task_type?: string | null
          tokens?: number | null
        }
        Update: {
          agent?: string
          created_at?: string | null
          id?: number
          latency_ms?: number | null
          model?: string | null
          provider?: string
          success?: boolean | null
          task_id?: number | null
          task_type?: string | null
          tokens?: number | null
        }
        Relationships: []
      }
      trinity_experiments: {
        Row: {
          bft_consensus_reached: boolean | null
          claim_category: string | null
          created_at: string | null
          detection_latency_ms: number | null
          dissent_score: number | null
          experiment_name: string
          false_claim: string
          filter_config_id: number | null
          filter_config_name: string | null
          hallucination_detected: boolean | null
          id: number
          proof_hash: string | null
          tested_by: string | null
          true_value: string
          veto_fired: boolean | null
        }
        Insert: {
          bft_consensus_reached?: boolean | null
          claim_category?: string | null
          created_at?: string | null
          detection_latency_ms?: number | null
          dissent_score?: number | null
          experiment_name: string
          false_claim: string
          filter_config_id?: number | null
          filter_config_name?: string | null
          hallucination_detected?: boolean | null
          id?: number
          proof_hash?: string | null
          tested_by?: string | null
          true_value: string
          veto_fired?: boolean | null
        }
        Update: {
          bft_consensus_reached?: boolean | null
          claim_category?: string | null
          created_at?: string | null
          detection_latency_ms?: number | null
          dissent_score?: number | null
          experiment_name?: string
          false_claim?: string
          filter_config_id?: number | null
          filter_config_name?: string | null
          hallucination_detected?: boolean | null
          id?: number
          proof_hash?: string | null
          tested_by?: string | null
          true_value?: string
          veto_fired?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "trinity_experiments_filter_config_id_fkey"
            columns: ["filter_config_id"]
            isOneToOne: false
            referencedRelation: "trinity_filter_configs"
            referencedColumns: ["id"]
          },
        ]
      }
      trinity_filter_configs: {
        Row: {
          bft_consensus_enabled: boolean | null
          config_name: string
          created_at: string | null
          description: string | null
          id: number
          is_baseline: boolean | null
          pythagorean_comma_enabled: boolean | null
          sbfa_enabled: boolean | null
          sbt_enabled: boolean | null
        }
        Insert: {
          bft_consensus_enabled?: boolean | null
          config_name: string
          created_at?: string | null
          description?: string | null
          id?: number
          is_baseline?: boolean | null
          pythagorean_comma_enabled?: boolean | null
          sbfa_enabled?: boolean | null
          sbt_enabled?: boolean | null
        }
        Update: {
          bft_consensus_enabled?: boolean | null
          config_name?: string
          created_at?: string | null
          description?: string | null
          id?: number
          is_baseline?: boolean | null
          pythagorean_comma_enabled?: boolean | null
          sbfa_enabled?: boolean | null
          sbt_enabled?: boolean | null
        }
        Relationships: []
      }
      trinity_fixes: {
        Row: {
          correct_fix: string | null
          created_at: string | null
          deployed_at: string | null
          deployed_by: string | null
          evidence_logs: string[] | null
          files_changed: Json | null
          fix_id: string
          id: number
          lesson: string | null
          patent_relevance: string[] | null
          prevention: string | null
          root_cause: string | null
          severity: string
          status: string
          symptom: string | null
          time_lost_hours: number | null
          title: string
          wrong_approaches: Json | null
        }
        Insert: {
          correct_fix?: string | null
          created_at?: string | null
          deployed_at?: string | null
          deployed_by?: string | null
          evidence_logs?: string[] | null
          files_changed?: Json | null
          fix_id: string
          id?: number
          lesson?: string | null
          patent_relevance?: string[] | null
          prevention?: string | null
          root_cause?: string | null
          severity: string
          status?: string
          symptom?: string | null
          time_lost_hours?: number | null
          title: string
          wrong_approaches?: Json | null
        }
        Update: {
          correct_fix?: string | null
          created_at?: string | null
          deployed_at?: string | null
          deployed_by?: string | null
          evidence_logs?: string[] | null
          files_changed?: Json | null
          fix_id?: string
          id?: number
          lesson?: string | null
          patent_relevance?: string[] | null
          prevention?: string | null
          root_cause?: string | null
          severity?: string
          status?: string
          symptom?: string | null
          time_lost_hours?: number | null
          title?: string
          wrong_approaches?: Json | null
        }
        Relationships: []
      }
      trinity_gemini_queue: {
        Row: {
          blocked_reason: string | null
          completed_at: string | null
          created_at: string | null
          id: number
          instructions: string
          priority: number | null
          result: string | null
          started_at: string | null
          status: string | null
          title: string
        }
        Insert: {
          blocked_reason?: string | null
          completed_at?: string | null
          created_at?: string | null
          id?: number
          instructions: string
          priority?: number | null
          result?: string | null
          started_at?: string | null
          status?: string | null
          title: string
        }
        Update: {
          blocked_reason?: string | null
          completed_at?: string | null
          created_at?: string | null
          id?: number
          instructions?: string
          priority?: number | null
          result?: string | null
          started_at?: string | null
          status?: string | null
          title?: string
        }
        Relationships: []
      }
      trinity_governance_config: {
        Row: {
          config_key: string
          config_value: Json
          description: string | null
          updated_at: string | null
        }
        Insert: {
          config_key: string
          config_value: Json
          description?: string | null
          updated_at?: string | null
        }
        Update: {
          config_key?: string
          config_value?: Json
          description?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      trinity_hallucination_logs: {
        Row: {
          agent_id: string
          dissent_score: number | null
          id: string
          injected_inputs: Json | null
          metadata: Json | null
          proof_hash: string | null
          task_id: string | null
          timestamp: string | null
          veto_reason: string | null
        }
        Insert: {
          agent_id: string
          dissent_score?: number | null
          id?: string
          injected_inputs?: Json | null
          metadata?: Json | null
          proof_hash?: string | null
          task_id?: string | null
          timestamp?: string | null
          veto_reason?: string | null
        }
        Update: {
          agent_id?: string
          dissent_score?: number | null
          id?: string
          injected_inputs?: Json | null
          metadata?: Json | null
          proof_hash?: string | null
          task_id?: string | null
          timestamp?: string | null
          veto_reason?: string | null
        }
        Relationships: []
      }
      trinity_hands_requests: {
        Row: {
          action_type: string
          approved_at: string | null
          created_at: string | null
          description: string
          estimated_cost: number | null
          ethics_score: number | null
          executed_at: string | null
          id: string
          plan: Json | null
          result: Json | null
          screenshot_url: string | null
          status: string | null
          user_id: string | null
        }
        Insert: {
          action_type: string
          approved_at?: string | null
          created_at?: string | null
          description: string
          estimated_cost?: number | null
          ethics_score?: number | null
          executed_at?: string | null
          id?: string
          plan?: Json | null
          result?: Json | null
          screenshot_url?: string | null
          status?: string | null
          user_id?: string | null
        }
        Update: {
          action_type?: string
          approved_at?: string | null
          created_at?: string | null
          description?: string
          estimated_cost?: number | null
          ethics_score?: number | null
          executed_at?: string | null
          id?: string
          plan?: Json | null
          result?: Json | null
          screenshot_url?: string | null
          status?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      trinity_healing_events: {
        Row: {
          affected_agents: string[] | null
          created_at: string | null
          detected_by: string
          diagnosis: Json | null
          healing_task_id: number | null
          id: number
          issue_type: string
          resolved_at: string | null
          status: string | null
        }
        Insert: {
          affected_agents?: string[] | null
          created_at?: string | null
          detected_by: string
          diagnosis?: Json | null
          healing_task_id?: number | null
          id?: number
          issue_type: string
          resolved_at?: string | null
          status?: string | null
        }
        Update: {
          affected_agents?: string[] | null
          created_at?: string | null
          detected_by?: string
          diagnosis?: Json | null
          healing_task_id?: number | null
          id?: number
          issue_type?: string
          resolved_at?: string | null
          status?: string | null
        }
        Relationships: []
      }
      trinity_heartbeat: {
        Row: {
          agent: string
          config: Json | null
          current_task_summary: string | null
          heartbeat_interval_ms: number | null
          id: number
          last_seen: string | null
          status: string | null
          version: string | null
        }
        Insert: {
          agent: string
          config?: Json | null
          current_task_summary?: string | null
          heartbeat_interval_ms?: number | null
          id?: number
          last_seen?: string | null
          status?: string | null
          version?: string | null
        }
        Update: {
          agent?: string
          config?: Json | null
          current_task_summary?: string | null
          heartbeat_interval_ms?: number | null
          id?: number
          last_seen?: string | null
          status?: string | null
          version?: string | null
        }
        Relationships: []
      }
      trinity_heartbeats: {
        Row: {
          created_at: string | null
          id: number
          manager_id: number | null
          message: string | null
          metrics: Json | null
          prompt_version: number | null
          status: string
        }
        Insert: {
          created_at?: string | null
          id?: number
          manager_id?: number | null
          message?: string | null
          metrics?: Json | null
          prompt_version?: number | null
          status: string
        }
        Update: {
          created_at?: string | null
          id?: number
          manager_id?: number | null
          message?: string | null
          metrics?: Json | null
          prompt_version?: number | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "trinity_heartbeats_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "trinity_managers"
            referencedColumns: ["id"]
          },
        ]
      }
      trinity_hitl_decisions: {
        Row: {
          agent_id: string
          agent_repid: string
          confidence_score: number | null
          created_at: string | null
          decided_at: string | null
          decision: string | null
          escalation_reason: string
          id: number
          mission_summary: string
          s_pi_score: number | null
          signature: string
          task_id: number | null
          telegram_message_id: number | null
        }
        Insert: {
          agent_id: string
          agent_repid: string
          confidence_score?: number | null
          created_at?: string | null
          decided_at?: string | null
          decision?: string | null
          escalation_reason: string
          id?: number
          mission_summary: string
          s_pi_score?: number | null
          signature: string
          task_id?: number | null
          telegram_message_id?: number | null
        }
        Update: {
          agent_id?: string
          agent_repid?: string
          confidence_score?: number | null
          created_at?: string | null
          decided_at?: string | null
          decision?: string | null
          escalation_reason?: string
          id?: number
          mission_summary?: string
          s_pi_score?: number | null
          signature?: string
          task_id?: number | null
          telegram_message_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "trinity_hitl_decisions_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "trinity_post_task_lag"
            referencedColumns: ["task_id"]
          },
          {
            foreignKeyName: "trinity_hitl_decisions_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "trinity_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      trinity_hitl_requests: {
        Row: {
          agent_id: string
          context: Json | null
          decision_metadata: Json | null
          id: string
          reason: string
          requested_at: string | null
          resolved_at: string | null
          resolved_by: string | null
          status: string
          task_id: number | null
        }
        Insert: {
          agent_id: string
          context?: Json | null
          decision_metadata?: Json | null
          id?: string
          reason: string
          requested_at?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          task_id?: number | null
        }
        Update: {
          agent_id?: string
          context?: Json | null
          decision_metadata?: Json | null
          id?: string
          reason?: string
          requested_at?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          task_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "trinity_hitl_requests_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "trinity_post_task_lag"
            referencedColumns: ["task_id"]
          },
          {
            foreignKeyName: "trinity_hitl_requests_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "trinity_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      trinity_immutable_records: {
        Row: {
          anchor_tx: string | null
          anchored_to: string | null
          created_at: string | null
          data: Json
          hash: string
          id: number
        }
        Insert: {
          anchor_tx?: string | null
          anchored_to?: string | null
          created_at?: string | null
          data: Json
          hash: string
          id?: number
        }
        Update: {
          anchor_tx?: string | null
          anchored_to?: string | null
          created_at?: string | null
          data?: Json
          hash?: string
          id?: number
        }
        Relationships: []
      }
      trinity_knowledge: {
        Row: {
          accessible_by: string[] | null
          category: string
          content: string
          created_at: string | null
          id: number
          priority: number | null
          source_name: string | null
          source_url: string | null
          status: string | null
          subcategory: string | null
          summary: string | null
          title: string
          updated_at: string | null
          version: string | null
        }
        Insert: {
          accessible_by?: string[] | null
          category: string
          content: string
          created_at?: string | null
          id?: number
          priority?: number | null
          source_name?: string | null
          source_url?: string | null
          status?: string | null
          subcategory?: string | null
          summary?: string | null
          title: string
          updated_at?: string | null
          version?: string | null
        }
        Update: {
          accessible_by?: string[] | null
          category?: string
          content?: string
          created_at?: string | null
          id?: number
          priority?: number | null
          source_name?: string | null
          source_url?: string | null
          status?: string | null
          subcategory?: string | null
          summary?: string | null
          title?: string
          updated_at?: string | null
          version?: string | null
        }
        Relationships: []
      }
      trinity_knowledge_base: {
        Row: {
          confidence_score: number | null
          created_at: string | null
          domain: string
          ethical_cleared: boolean | null
          gap_topic: string
          id: string
          insight: string | null
          sources: Json | null
          summarized: string | null
          updated_at: string | null
          verified_by_veritas: boolean | null
        }
        Insert: {
          confidence_score?: number | null
          created_at?: string | null
          domain: string
          ethical_cleared?: boolean | null
          gap_topic: string
          id?: string
          insight?: string | null
          sources?: Json | null
          summarized?: string | null
          updated_at?: string | null
          verified_by_veritas?: boolean | null
        }
        Update: {
          confidence_score?: number | null
          created_at?: string | null
          domain?: string
          ethical_cleared?: boolean | null
          gap_topic?: string
          id?: string
          insight?: string | null
          sources?: Json | null
          summarized?: string | null
          updated_at?: string | null
          verified_by_veritas?: boolean | null
        }
        Relationships: []
      }
      trinity_kv_store: {
        Row: {
          created_at: string | null
          key: string
          tier: string | null
          updated_at: string | null
          value: Json
        }
        Insert: {
          created_at?: string | null
          key: string
          tier?: string | null
          updated_at?: string | null
          value: Json
        }
        Update: {
          created_at?: string | null
          key?: string
          tier?: string | null
          updated_at?: string | null
          value?: Json
        }
        Relationships: []
      }
      trinity_langgraph_checkpoints: {
        Row: {
          checkpoint_data: Json
          created_at: string | null
          expires_at: string | null
          graph_id: string
          id: number
          is_complete: boolean | null
          node_name: string | null
          parent_checkpoint_id: number | null
          squad: string
        }
        Insert: {
          checkpoint_data: Json
          created_at?: string | null
          expires_at?: string | null
          graph_id: string
          id?: number
          is_complete?: boolean | null
          node_name?: string | null
          parent_checkpoint_id?: number | null
          squad: string
        }
        Update: {
          checkpoint_data?: Json
          created_at?: string | null
          expires_at?: string | null
          graph_id?: string
          id?: number
          is_complete?: boolean | null
          node_name?: string | null
          parent_checkpoint_id?: number | null
          squad?: string
        }
        Relationships: [
          {
            foreignKeyName: "trinity_langgraph_checkpoints_parent_checkpoint_id_fkey"
            columns: ["parent_checkpoint_id"]
            isOneToOne: false
            referencedRelation: "trinity_langgraph_checkpoints"
            referencedColumns: ["id"]
          },
        ]
      }
      trinity_leads: {
        Row: {
          created_at: string | null
          email: string
          github: string | null
          github_handle: string | null
          id: string
          interest: string | null
          linkedin: string | null
          linkedin_handle: string | null
          metadata: Json | null
          points: number | null
          preferred_ecosystem: string | null
          referral_code: string | null
          referred_by: string | null
          role: string | null
          status: string | null
        }
        Insert: {
          created_at?: string | null
          email: string
          github?: string | null
          github_handle?: string | null
          id?: string
          interest?: string | null
          linkedin?: string | null
          linkedin_handle?: string | null
          metadata?: Json | null
          points?: number | null
          preferred_ecosystem?: string | null
          referral_code?: string | null
          referred_by?: string | null
          role?: string | null
          status?: string | null
        }
        Update: {
          created_at?: string | null
          email?: string
          github?: string | null
          github_handle?: string | null
          id?: string
          interest?: string | null
          linkedin?: string | null
          linkedin_handle?: string | null
          metadata?: Json | null
          points?: number | null
          preferred_ecosystem?: string | null
          referral_code?: string | null
          referred_by?: string | null
          role?: string | null
          status?: string | null
        }
        Relationships: []
      }
      trinity_learned_patterns: {
        Row: {
          confidence: number | null
          created_at: string | null
          discovered_by: string
          embedding: string | null
          id: number
          learned_insight: string
          pattern_type: string
          task_id: number | null
          trigger_keywords: string[] | null
        }
        Insert: {
          confidence?: number | null
          created_at?: string | null
          discovered_by: string
          embedding?: string | null
          id?: number
          learned_insight: string
          pattern_type: string
          task_id?: number | null
          trigger_keywords?: string[] | null
        }
        Update: {
          confidence?: number | null
          created_at?: string | null
          discovered_by?: string
          embedding?: string | null
          id?: number
          learned_insight?: string
          pattern_type?: string
          task_id?: number | null
          trigger_keywords?: string[] | null
        }
        Relationships: []
      }
      trinity_learning_metrics: {
        Row: {
          agent: string
          context: Json | null
          created_at: string | null
          id: number
          loop_type: string
          metric_name: string
          metric_value: number | null
        }
        Insert: {
          agent: string
          context?: Json | null
          created_at?: string | null
          id?: number
          loop_type: string
          metric_name: string
          metric_value?: number | null
        }
        Update: {
          agent?: string
          context?: Json | null
          created_at?: string | null
          id?: number
          loop_type?: string
          metric_name?: string
          metric_value?: number | null
        }
        Relationships: []
      }
      trinity_managers: {
        Row: {
          created_at: string | null
          current_prompt_version: number | null
          display_name: string
          id: number
          is_active: boolean | null
          last_heartbeat: string | null
          metadata: Json | null
          name: string
          specialty: string
          system_url: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          current_prompt_version?: number | null
          display_name: string
          id?: number
          is_active?: boolean | null
          last_heartbeat?: string | null
          metadata?: Json | null
          name: string
          specialty: string
          system_url?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          current_prompt_version?: number | null
          display_name?: string
          id?: number
          is_active?: boolean | null
          last_heartbeat?: string | null
          metadata?: Json | null
          name?: string
          specialty?: string
          system_url?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      trinity_master_plan: {
        Row: {
          constitutional_foundation: Json
          content: Json
          created_at: string | null
          execution_order: Json
          id: string
          locked_at: string | null
          locked_by: string | null
          locked_decisions: Json
          status: string | null
          success_metrics: Json
          title: string
          version: string
        }
        Insert: {
          constitutional_foundation: Json
          content: Json
          created_at?: string | null
          execution_order: Json
          id?: string
          locked_at?: string | null
          locked_by?: string | null
          locked_decisions: Json
          status?: string | null
          success_metrics: Json
          title: string
          version: string
        }
        Update: {
          constitutional_foundation?: Json
          content?: Json
          created_at?: string | null
          execution_order?: Json
          id?: string
          locked_at?: string | null
          locked_by?: string | null
          locked_decisions?: Json
          status?: string | null
          success_metrics?: Json
          title?: string
          version?: string
        }
        Relationships: []
      }
      trinity_mcp_events: {
        Row: {
          consumed_by: string[] | null
          created_at: string | null
          event_type: string
          expires_at: string | null
          id: number
          payload: Json | null
          source_agent: string | null
          target_agent: string | null
        }
        Insert: {
          consumed_by?: string[] | null
          created_at?: string | null
          event_type: string
          expires_at?: string | null
          id?: number
          payload?: Json | null
          source_agent?: string | null
          target_agent?: string | null
        }
        Update: {
          consumed_by?: string[] | null
          created_at?: string | null
          event_type?: string
          expires_at?: string | null
          id?: number
          payload?: Json | null
          source_agent?: string | null
          target_agent?: string | null
        }
        Relationships: []
      }
      trinity_mcp_handoffs: {
        Row: {
          confirmed_at: string | null
          confirmed_by: string | null
          created_at: string | null
          from_agent: string | null
          handoff_reason: string | null
          id: number
          requires_confirmation: boolean | null
          skill_matched: string | null
          task_id: number | null
          to_agent: string | null
          trust_score_at_handoff: number | null
        }
        Insert: {
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string | null
          from_agent?: string | null
          handoff_reason?: string | null
          id?: number
          requires_confirmation?: boolean | null
          skill_matched?: string | null
          task_id?: number | null
          to_agent?: string | null
          trust_score_at_handoff?: number | null
        }
        Update: {
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string | null
          from_agent?: string | null
          handoff_reason?: string | null
          id?: number
          requires_confirmation?: boolean | null
          skill_matched?: string | null
          task_id?: number | null
          to_agent?: string | null
          trust_score_at_handoff?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "trinity_mcp_handoffs_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "trinity_post_task_lag"
            referencedColumns: ["task_id"]
          },
          {
            foreignKeyName: "trinity_mcp_handoffs_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "trinity_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      trinity_mcp_registry: {
        Row: {
          created_at: string | null
          description: string | null
          github_path: string
          id: number
          is_public: boolean | null
          keywords: string[] | null
          name: string
          product: string
          task_types: string[] | null
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          github_path: string
          id?: number
          is_public?: boolean | null
          keywords?: string[] | null
          name: string
          product: string
          task_types?: string[] | null
        }
        Update: {
          created_at?: string | null
          description?: string | null
          github_path?: string
          id?: number
          is_public?: boolean | null
          keywords?: string[] | null
          name?: string
          product?: string
          task_types?: string[] | null
        }
        Relationships: []
      }
      trinity_mcp_servers: {
        Row: {
          auth_type: string | null
          capabilities: Json | null
          created_at: string | null
          description: string | null
          endpoint: string
          id: number
          name: string
          priority: number | null
          status: string | null
        }
        Insert: {
          auth_type?: string | null
          capabilities?: Json | null
          created_at?: string | null
          description?: string | null
          endpoint: string
          id?: number
          name: string
          priority?: number | null
          status?: string | null
        }
        Update: {
          auth_type?: string | null
          capabilities?: Json | null
          created_at?: string | null
          description?: string | null
          endpoint?: string
          id?: number
          name?: string
          priority?: number | null
          status?: string | null
        }
        Relationships: []
      }
      trinity_memories: {
        Row: {
          always_do: string[] | null
          connects_to: string[] | null
          constitutional_alignment: boolean | null
          created_at: string | null
          emotional_weight: number
          id: string
          keywords: string[]
          memory_text: string
          memory_tier: string | null
          never_do: string[] | null
          never_prune: boolean | null
          predictive_weight: number
          updated_at: string | null
        }
        Insert: {
          always_do?: string[] | null
          connects_to?: string[] | null
          constitutional_alignment?: boolean | null
          created_at?: string | null
          emotional_weight?: number
          id?: string
          keywords?: string[]
          memory_text: string
          memory_tier?: string | null
          never_do?: string[] | null
          never_prune?: boolean | null
          predictive_weight?: number
          updated_at?: string | null
        }
        Update: {
          always_do?: string[] | null
          connects_to?: string[] | null
          constitutional_alignment?: boolean | null
          created_at?: string | null
          emotional_weight?: number
          id?: string
          keywords?: string[]
          memory_text?: string
          memory_tier?: string | null
          never_do?: string[] | null
          never_prune?: boolean | null
          predictive_weight?: number
          updated_at?: string | null
        }
        Relationships: []
      }
      trinity_mock_calls: {
        Row: {
          args: Json | null
          call_count: number | null
          id: string
          last_called_at: string | null
          method_name: string
        }
        Insert: {
          args?: Json | null
          call_count?: number | null
          id?: string
          last_called_at?: string | null
          method_name: string
        }
        Update: {
          args?: Json | null
          call_count?: number | null
          id?: string
          last_called_at?: string | null
          method_name?: string
        }
        Relationships: []
      }
      trinity_pending_actions: {
        Row: {
          action_type: string
          agent: string
          artifact_id: number | null
          created_at: string | null
          description: string | null
          executed_at: string | null
          execution_result: Json | null
          expires_at: string | null
          id: number
          payload: Json
          review_notes: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          risk_level: string | null
          status: string | null
          title: string
        }
        Insert: {
          action_type: string
          agent: string
          artifact_id?: number | null
          created_at?: string | null
          description?: string | null
          executed_at?: string | null
          execution_result?: Json | null
          expires_at?: string | null
          id?: number
          payload: Json
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          risk_level?: string | null
          status?: string | null
          title: string
        }
        Update: {
          action_type?: string
          agent?: string
          artifact_id?: number | null
          created_at?: string | null
          description?: string | null
          executed_at?: string | null
          execution_result?: Json | null
          expires_at?: string | null
          id?: number
          payload?: Json
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          risk_level?: string | null
          status?: string | null
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "trinity_pending_actions_artifact_id_fkey"
            columns: ["artifact_id"]
            isOneToOne: false
            referencedRelation: "trinity_artifacts"
            referencedColumns: ["id"]
          },
        ]
      }
      trinity_protected_tasks: {
        Row: {
          created_at: string | null
          protected_by: string | null
          task_id: number
        }
        Insert: {
          created_at?: string | null
          protected_by?: string | null
          task_id: number
        }
        Update: {
          created_at?: string | null
          protected_by?: string | null
          task_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "trinity_protected_tasks_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: true
            referencedRelation: "trinity_post_task_lag"
            referencedColumns: ["task_id"]
          },
          {
            foreignKeyName: "trinity_protected_tasks_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: true
            referencedRelation: "trinity_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      trinity_receipt_bft_results: {
        Row: {
          comma_dissonance: number | null
          computed_at: string | null
          decisive_count: number
          final_verdict: string
          indeterminate_count: number
          pass_count: number
          pass_ratio: number
          receipt_id: string
          veto_count: number
        }
        Insert: {
          comma_dissonance?: number | null
          computed_at?: string | null
          decisive_count: number
          final_verdict: string
          indeterminate_count: number
          pass_count: number
          pass_ratio: number
          receipt_id: string
          veto_count: number
        }
        Update: {
          comma_dissonance?: number | null
          computed_at?: string | null
          decisive_count?: number
          final_verdict?: string
          indeterminate_count?: number
          pass_count?: number
          pass_ratio?: number
          receipt_id?: string
          veto_count?: number
        }
        Relationships: []
      }
      trinity_receipt_validators: {
        Row: {
          agent_name: string
          attested_at: string | null
          confidence: number | null
          id: number
          reasoning_hash: string | null
          receipt_id: string
          signature: string | null
          verdict: string
        }
        Insert: {
          agent_name: string
          attested_at?: string | null
          confidence?: number | null
          id?: number
          reasoning_hash?: string | null
          receipt_id: string
          signature?: string | null
          verdict: string
        }
        Update: {
          agent_name?: string
          attested_at?: string | null
          confidence?: number | null
          id?: number
          reasoning_hash?: string | null
          receipt_id?: string
          signature?: string | null
          verdict?: string
        }
        Relationships: []
      }
      trinity_referrals: {
        Row: {
          bonus_paid: number | null
          created_at: string | null
          id: string
          referee_id: string
          referral_code: string | null
          referrer_id: string
          status: string | null
        }
        Insert: {
          bonus_paid?: number | null
          created_at?: string | null
          id?: string
          referee_id: string
          referral_code?: string | null
          referrer_id: string
          status?: string | null
        }
        Update: {
          bonus_paid?: number | null
          created_at?: string | null
          id?: string
          referee_id?: string
          referral_code?: string | null
          referrer_id?: string
          status?: string | null
        }
        Relationships: []
      }
      trinity_repid: {
        Row: {
          agent: string
          healing_contributions: number | null
          primary_virtue: string | null
          sabbath_reflections: number | null
          score: number | null
          tasks_completed: number | null
          tasks_verified: number | null
          truth_choices: number | null
          updated_at: string | null
        }
        Insert: {
          agent: string
          healing_contributions?: number | null
          primary_virtue?: string | null
          sabbath_reflections?: number | null
          score?: number | null
          tasks_completed?: number | null
          tasks_verified?: number | null
          truth_choices?: number | null
          updated_at?: string | null
        }
        Update: {
          agent?: string
          healing_contributions?: number | null
          primary_virtue?: string | null
          sabbath_reflections?: number | null
          score?: number | null
          tasks_completed?: number | null
          tasks_verified?: number | null
          truth_choices?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      trinity_repid_events: {
        Row: {
          created_at: string | null
          event_data: Json | null
          event_type: string
          id: number
          reputation_delta: number | null
          subject_id: string | null
          subject_type: string
        }
        Insert: {
          created_at?: string | null
          event_data?: Json | null
          event_type: string
          id?: number
          reputation_delta?: number | null
          subject_id?: string | null
          subject_type: string
        }
        Update: {
          created_at?: string | null
          event_data?: Json | null
          event_type?: string
          id?: number
          reputation_delta?: number | null
          subject_id?: string | null
          subject_type?: string
        }
        Relationships: []
      }
      trinity_research_log: {
        Row: {
          agent: string
          created_at: string
          gap: string
          id: string
          resources: Json | null
          status: string | null
          summary: string
        }
        Insert: {
          agent: string
          created_at?: string
          gap: string
          id?: string
          resources?: Json | null
          status?: string | null
          summary: string
        }
        Update: {
          agent?: string
          created_at?: string
          gap?: string
          id?: string
          resources?: Json | null
          status?: string | null
          summary?: string
        }
        Relationships: []
      }
      trinity_retros: {
        Row: {
          agent: string
          created_at: string
          failures: string | null
          id: string
          lessons: string | null
          reflection: string
          successes: string | null
        }
        Insert: {
          agent: string
          created_at?: string
          failures?: string | null
          id?: string
          lessons?: string | null
          reflection: string
          successes?: string | null
        }
        Update: {
          agent?: string
          created_at?: string
          failures?: string | null
          id?: string
          lessons?: string | null
          reflection?: string
          successes?: string | null
        }
        Relationships: []
      }
      trinity_runtime_errors: {
        Row: {
          component_stack: string | null
          error_message: string | null
          id: string
          resolution_notes: string | null
          stack_trace: string | null
          status: string | null
          timestamp: string | null
          url: string | null
          user_agent: string | null
        }
        Insert: {
          component_stack?: string | null
          error_message?: string | null
          id?: string
          resolution_notes?: string | null
          stack_trace?: string | null
          status?: string | null
          timestamp?: string | null
          url?: string | null
          user_agent?: string | null
        }
        Update: {
          component_stack?: string | null
          error_message?: string | null
          id?: string
          resolution_notes?: string | null
          stack_trace?: string | null
          status?: string | null
          timestamp?: string | null
          url?: string | null
          user_agent?: string | null
        }
        Relationships: []
      }
      trinity_service_registry: {
        Row: {
          cost_per_m_tokens: number | null
          created_at: string | null
          id: string
          is_active: boolean | null
          latency_ms_avg: number | null
          metadata: Json | null
          model_id: string | null
          provider: string
          service_key: string
          service_type: string
          specialties: string[] | null
          tier: number | null
          updated_at: string | null
        }
        Insert: {
          cost_per_m_tokens?: number | null
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          latency_ms_avg?: number | null
          metadata?: Json | null
          model_id?: string | null
          provider: string
          service_key: string
          service_type: string
          specialties?: string[] | null
          tier?: number | null
          updated_at?: string | null
        }
        Update: {
          cost_per_m_tokens?: number | null
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          latency_ms_avg?: number | null
          metadata?: Json | null
          model_id?: string | null
          provider?: string
          service_key?: string
          service_type?: string
          specialties?: string[] | null
          tier?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      trinity_shofet_rulings: {
        Row: {
          confirmed_at: string | null
          confirmed_by: string | null
          created_at: string | null
          evidence: Json | null
          executed_at: string | null
          id: number
          outcome: string | null
          requires_confirmation: boolean | null
          ruling_reason: string
          ruling_type: string
          shofet_repid_at_ruling: number | null
          target_agent: string | null
          target_task_id: number | null
        }
        Insert: {
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string | null
          evidence?: Json | null
          executed_at?: string | null
          id?: number
          outcome?: string | null
          requires_confirmation?: boolean | null
          ruling_reason: string
          ruling_type: string
          shofet_repid_at_ruling?: number | null
          target_agent?: string | null
          target_task_id?: number | null
        }
        Update: {
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string | null
          evidence?: Json | null
          executed_at?: string | null
          id?: number
          outcome?: string | null
          requires_confirmation?: boolean | null
          ruling_reason?: string
          ruling_type?: string
          shofet_repid_at_ruling?: number | null
          target_agent?: string | null
          target_task_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "trinity_shofet_rulings_target_task_id_fkey"
            columns: ["target_task_id"]
            isOneToOne: false
            referencedRelation: "trinity_post_task_lag"
            referencedColumns: ["task_id"]
          },
          {
            foreignKeyName: "trinity_shofet_rulings_target_task_id_fkey"
            columns: ["target_task_id"]
            isOneToOne: false
            referencedRelation: "trinity_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      trinity_signals: {
        Row: {
          created_at: string | null
          id: string
          payload: Json | null
          processed_at: string | null
          processed_by: string | null
          signal_type: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          payload?: Json | null
          processed_at?: string | null
          processed_by?: string | null
          signal_type: string
        }
        Update: {
          created_at?: string | null
          id?: string
          payload?: Json | null
          processed_at?: string | null
          processed_by?: string | null
          signal_type?: string
        }
        Relationships: []
      }
      trinity_skills: {
        Row: {
          avg_duration_seconds: number | null
          avg_success_rate: number | null
          capable_agents: string[] | null
          created_at: string | null
          example_call: Json | null
          id: number
          input_schema: Json | null
          last_used_at: string | null
          min_repid_required: number | null
          output_schema: Json | null
          skill_category: string | null
          skill_description: string | null
          skill_name: string
          tool_url: string | null
        }
        Insert: {
          avg_duration_seconds?: number | null
          avg_success_rate?: number | null
          capable_agents?: string[] | null
          created_at?: string | null
          example_call?: Json | null
          id?: number
          input_schema?: Json | null
          last_used_at?: string | null
          min_repid_required?: number | null
          output_schema?: Json | null
          skill_category?: string | null
          skill_description?: string | null
          skill_name: string
          tool_url?: string | null
        }
        Update: {
          avg_duration_seconds?: number | null
          avg_success_rate?: number | null
          capable_agents?: string[] | null
          created_at?: string | null
          example_call?: Json | null
          id?: number
          input_schema?: Json | null
          last_used_at?: string | null
          min_repid_required?: number | null
          output_schema?: Json | null
          skill_category?: string | null
          skill_description?: string | null
          skill_name?: string
          tool_url?: string | null
        }
        Relationships: []
      }
      trinity_spawn_patterns: {
        Row: {
          created_at: string | null
          id: number
          priority_offset: number | null
          spawn_description: string | null
          spawn_title: string
          task_type: string | null
          times_triggered: number | null
          trigger_pattern: string
        }
        Insert: {
          created_at?: string | null
          id?: number
          priority_offset?: number | null
          spawn_description?: string | null
          spawn_title: string
          task_type?: string | null
          times_triggered?: number | null
          trigger_pattern: string
        }
        Update: {
          created_at?: string | null
          id?: number
          priority_offset?: number | null
          spawn_description?: string | null
          spawn_title?: string
          task_type?: string | null
          times_triggered?: number | null
          trigger_pattern?: string
        }
        Relationships: []
      }
      trinity_system_config: {
        Row: {
          burn_rate_status: string | null
          deployer_wallet: string | null
          id: number
          north_star_directive: string | null
          updated_at: string | null
          updated_by: string | null
        }
        Insert: {
          burn_rate_status?: string | null
          deployer_wallet?: string | null
          id?: number
          north_star_directive?: string | null
          updated_at?: string | null
          updated_by?: string | null
        }
        Update: {
          burn_rate_status?: string | null
          deployer_wallet?: string | null
          id?: number
          north_star_directive?: string | null
          updated_at?: string | null
          updated_by?: string | null
        }
        Relationships: []
      }
      trinity_system_metrics: {
        Row: {
          id: number
          measured_at: string | null
          metadata: Json | null
          metric_name: string
          metric_value: number | null
          period_end: string | null
          period_start: string | null
        }
        Insert: {
          id?: number
          measured_at?: string | null
          metadata?: Json | null
          metric_name: string
          metric_value?: number | null
          period_end?: string | null
          period_start?: string | null
        }
        Update: {
          id?: number
          measured_at?: string | null
          metadata?: Json | null
          metric_name?: string
          metric_value?: number | null
          period_end?: string | null
          period_start?: string | null
        }
        Relationships: []
      }
      trinity_task_activity: {
        Row: {
          action: string
          actor: string
          created_at: string | null
          id: number
          new_value: Json | null
          notes: string | null
          task_id: number | null
          verification_status: string | null
        }
        Insert: {
          action: string
          actor: string
          created_at?: string | null
          id?: number
          new_value?: Json | null
          notes?: string | null
          task_id?: number | null
          verification_status?: string | null
        }
        Update: {
          action?: string
          actor?: string
          created_at?: string | null
          id?: number
          new_value?: Json | null
          notes?: string | null
          task_id?: number | null
          verification_status?: string | null
        }
        Relationships: []
      }
      trinity_task_archive: {
        Row: {
          archive_reason: string | null
          archived_at: string | null
          assigned_to: string | null
          completed_at: string | null
          created_at: string | null
          description: string | null
          id: number | null
          result: string | null
          status: string | null
          title: string | null
        }
        Insert: {
          archive_reason?: string | null
          archived_at?: string | null
          assigned_to?: string | null
          completed_at?: string | null
          created_at?: string | null
          description?: string | null
          id?: number | null
          result?: string | null
          status?: string | null
          title?: string | null
        }
        Update: {
          archive_reason?: string | null
          archived_at?: string | null
          assigned_to?: string | null
          completed_at?: string | null
          created_at?: string | null
          description?: string | null
          id?: number | null
          result?: string | null
          status?: string | null
          title?: string | null
        }
        Relationships: []
      }
      trinity_task_audit_log: {
        Row: {
          action: string
          changed_by: string | null
          created_at: string | null
          id: string
          metadata: Json | null
          new_value: string | null
          old_value: string | null
          reason: string | null
          task_id: number
        }
        Insert: {
          action: string
          changed_by?: string | null
          created_at?: string | null
          id?: string
          metadata?: Json | null
          new_value?: string | null
          old_value?: string | null
          reason?: string | null
          task_id: number
        }
        Update: {
          action?: string
          changed_by?: string | null
          created_at?: string | null
          id?: string
          metadata?: Json | null
          new_value?: string | null
          old_value?: string | null
          reason?: string | null
          task_id?: number
        }
        Relationships: []
      }
      trinity_task_tags: {
        Row: {
          created_at: string | null
          id: string
          notes: string | null
          tag: string
          tag_category: string | null
          tagged_by: string | null
          task_id: number
        }
        Insert: {
          created_at?: string | null
          id?: string
          notes?: string | null
          tag: string
          tag_category?: string | null
          tagged_by?: string | null
          task_id: number
        }
        Update: {
          created_at?: string | null
          id?: string
          notes?: string | null
          tag?: string
          tag_category?: string | null
          tagged_by?: string | null
          task_id?: number
        }
        Relationships: []
      }
      trinity_task_templates: {
        Row: {
          created_at: string | null
          description: string | null
          id: string
          name: string
          next_task_template: string | null
          prompt_template: string
          required_output_format: Json
          validation_rules: Json | null
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          id?: string
          name: string
          next_task_template?: string | null
          prompt_template: string
          required_output_format: Json
          validation_rules?: Json | null
        }
        Update: {
          created_at?: string | null
          description?: string | null
          id?: string
          name?: string
          next_task_template?: string | null
          prompt_template?: string
          required_output_format?: Json
          validation_rules?: Json | null
        }
        Relationships: []
      }
      trinity_task_votes: {
        Row: {
          created_at: string | null
          id: number
          reason: string | null
          task_id: number | null
          vote: string | null
          voter_agent: string
        }
        Insert: {
          created_at?: string | null
          id?: number
          reason?: string | null
          task_id?: number | null
          vote?: string | null
          voter_agent: string
        }
        Update: {
          created_at?: string | null
          id?: number
          reason?: string | null
          task_id?: number | null
          vote?: string | null
          voter_agent?: string
        }
        Relationships: [
          {
            foreignKeyName: "trinity_task_votes_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "trinity_post_task_lag"
            referencedColumns: ["task_id"]
          },
          {
            foreignKeyName: "trinity_task_votes_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "trinity_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      trinity_tasks: {
        Row: {
          actual_cost: number | null
          agent_assigned: string | null
          agent_name: string | null
          artifact_url: string | null
          assigned_to: string | null
          belief: number | null
          blocks_tags: string[] | null
          can_parallel: boolean | null
          certainty: number | null
          claimed_at: string | null
          claimed_by: string | null
          completed_at: string | null
          completed_by: string | null
          consensus_group: string | null
          created_at: string | null
          dependencies: string[] | null
          dependency_tags: string[] | null
          description: string
          disbelief: number | null
          escalated_at: string | null
          escalated_to: string | null
          escalation_level: number | null
          estimated_cost: number | null
          estimated_minutes: number | null
          expected_output: string | null
          expires_at: string | null
          external_artifact_url: string | null
          failure_reflection: string | null
          feature_tag: string | null
          final_verdict: string | null
          generation: number | null
          github_issue_number: number | null
          github_issue_url: string | null
          id: number
          insert_source: string | null
          is_evergreen: boolean | null
          is_real: boolean | null
          last_spawned_at: string | null
          max_duration_minutes: number | null
          metadata: Json | null
          needs_peer: boolean | null
          parent_task_id: number | null
          pipeline_stage: number | null
          priority: number | null
          progress_percent: number | null
          project_id: string | null
          proof_of_work: string | null
          reasoning_depth: number | null
          recurring_minutes: number | null
          reflected: boolean | null
          rep_id_stake: number | null
          repid_score: number | null
          repid_verified: boolean | null
          requires_consensus: boolean | null
          requires_external_artifact: boolean | null
          result: string | null
          score: number | null
          self_certainty: number | null
          signatures: Json | null
          spawned_count: number | null
          sprint_tag: string | null
          started_at: string | null
          status: string | null
          stuck_reason: string | null
          success_criteria: string | null
          tags: string[] | null
          task_category: string | null
          task_type: string | null
          tiebreaker_agent_id: string | null
          tiebreaker_evidence: string | null
          tiebreaker_verdict: string | null
          tiebroken_at: string | null
          tier: number | null
          title: string | null
          uncertainty: number | null
          updated_at: string | null
          use_acp: boolean | null
          v1_stub: boolean | null
          value_score: number | null
          verification_details: Json | null
          verification_method: string | null
          verification_proof: string | null
          verification_required: boolean | null
          verification_result: string | null
          verification_triad: string | null
          verified_at: string | null
          verified_by: string[] | null
          verified_output: Json | null
          verifier_agent_id: string | null
          verifier_evidence: string | null
          verifier_verdict: string | null
          verify_count: number | null
          workspace_id: string | null
        }
        Insert: {
          actual_cost?: number | null
          agent_assigned?: string | null
          agent_name?: string | null
          artifact_url?: string | null
          assigned_to?: string | null
          belief?: number | null
          blocks_tags?: string[] | null
          can_parallel?: boolean | null
          certainty?: number | null
          claimed_at?: string | null
          claimed_by?: string | null
          completed_at?: string | null
          completed_by?: string | null
          consensus_group?: string | null
          created_at?: string | null
          dependencies?: string[] | null
          dependency_tags?: string[] | null
          description: string
          disbelief?: number | null
          escalated_at?: string | null
          escalated_to?: string | null
          escalation_level?: number | null
          estimated_cost?: number | null
          estimated_minutes?: number | null
          expected_output?: string | null
          expires_at?: string | null
          external_artifact_url?: string | null
          failure_reflection?: string | null
          feature_tag?: string | null
          final_verdict?: string | null
          generation?: number | null
          github_issue_number?: number | null
          github_issue_url?: string | null
          id?: number
          insert_source?: string | null
          is_evergreen?: boolean | null
          is_real?: boolean | null
          last_spawned_at?: string | null
          max_duration_minutes?: number | null
          metadata?: Json | null
          needs_peer?: boolean | null
          parent_task_id?: number | null
          pipeline_stage?: number | null
          priority?: number | null
          progress_percent?: number | null
          project_id?: string | null
          proof_of_work?: string | null
          reasoning_depth?: number | null
          recurring_minutes?: number | null
          reflected?: boolean | null
          rep_id_stake?: number | null
          repid_score?: number | null
          repid_verified?: boolean | null
          requires_consensus?: boolean | null
          requires_external_artifact?: boolean | null
          result?: string | null
          score?: number | null
          self_certainty?: number | null
          signatures?: Json | null
          spawned_count?: number | null
          sprint_tag?: string | null
          started_at?: string | null
          status?: string | null
          stuck_reason?: string | null
          success_criteria?: string | null
          tags?: string[] | null
          task_category?: string | null
          task_type?: string | null
          tiebreaker_agent_id?: string | null
          tiebreaker_evidence?: string | null
          tiebreaker_verdict?: string | null
          tiebroken_at?: string | null
          tier?: number | null
          title?: string | null
          uncertainty?: number | null
          updated_at?: string | null
          use_acp?: boolean | null
          v1_stub?: boolean | null
          value_score?: number | null
          verification_details?: Json | null
          verification_method?: string | null
          verification_proof?: string | null
          verification_required?: boolean | null
          verification_result?: string | null
          verification_triad?: string | null
          verified_at?: string | null
          verified_by?: string[] | null
          verified_output?: Json | null
          verifier_agent_id?: string | null
          verifier_evidence?: string | null
          verifier_verdict?: string | null
          verify_count?: number | null
          workspace_id?: string | null
        }
        Update: {
          actual_cost?: number | null
          agent_assigned?: string | null
          agent_name?: string | null
          artifact_url?: string | null
          assigned_to?: string | null
          belief?: number | null
          blocks_tags?: string[] | null
          can_parallel?: boolean | null
          certainty?: number | null
          claimed_at?: string | null
          claimed_by?: string | null
          completed_at?: string | null
          completed_by?: string | null
          consensus_group?: string | null
          created_at?: string | null
          dependencies?: string[] | null
          dependency_tags?: string[] | null
          description?: string
          disbelief?: number | null
          escalated_at?: string | null
          escalated_to?: string | null
          escalation_level?: number | null
          estimated_cost?: number | null
          estimated_minutes?: number | null
          expected_output?: string | null
          expires_at?: string | null
          external_artifact_url?: string | null
          failure_reflection?: string | null
          feature_tag?: string | null
          final_verdict?: string | null
          generation?: number | null
          github_issue_number?: number | null
          github_issue_url?: string | null
          id?: number
          insert_source?: string | null
          is_evergreen?: boolean | null
          is_real?: boolean | null
          last_spawned_at?: string | null
          max_duration_minutes?: number | null
          metadata?: Json | null
          needs_peer?: boolean | null
          parent_task_id?: number | null
          pipeline_stage?: number | null
          priority?: number | null
          progress_percent?: number | null
          project_id?: string | null
          proof_of_work?: string | null
          reasoning_depth?: number | null
          recurring_minutes?: number | null
          reflected?: boolean | null
          rep_id_stake?: number | null
          repid_score?: number | null
          repid_verified?: boolean | null
          requires_consensus?: boolean | null
          requires_external_artifact?: boolean | null
          result?: string | null
          score?: number | null
          self_certainty?: number | null
          signatures?: Json | null
          spawned_count?: number | null
          sprint_tag?: string | null
          started_at?: string | null
          status?: string | null
          stuck_reason?: string | null
          success_criteria?: string | null
          tags?: string[] | null
          task_category?: string | null
          task_type?: string | null
          tiebreaker_agent_id?: string | null
          tiebreaker_evidence?: string | null
          tiebreaker_verdict?: string | null
          tiebroken_at?: string | null
          tier?: number | null
          title?: string | null
          uncertainty?: number | null
          updated_at?: string | null
          use_acp?: boolean | null
          v1_stub?: boolean | null
          value_score?: number | null
          verification_details?: Json | null
          verification_method?: string | null
          verification_proof?: string | null
          verification_required?: boolean | null
          verification_result?: string | null
          verification_triad?: string | null
          verified_at?: string | null
          verified_by?: string[] | null
          verified_output?: Json | null
          verifier_agent_id?: string | null
          verifier_evidence?: string | null
          verifier_verdict?: string | null
          verify_count?: number | null
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "trinity_tasks_parent_task_id_fkey"
            columns: ["parent_task_id"]
            isOneToOne: false
            referencedRelation: "trinity_post_task_lag"
            referencedColumns: ["task_id"]
          },
          {
            foreignKeyName: "trinity_tasks_parent_task_id_fkey"
            columns: ["parent_task_id"]
            isOneToOne: false
            referencedRelation: "trinity_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trinity_tasks_tiebreaker_agent_id_fkey"
            columns: ["tiebreaker_agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trinity_tasks_verifier_agent_id_fkey"
            columns: ["verifier_agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      trinity_tool_usage: {
        Row: {
          agent_id: string | null
          bilateral_learning_delta: number | null
          constitutional_compliance_score: number | null
          created_at: string | null
          eas_attestation_id: string | null
          id: string
          latency_ms: number | null
          mcp_call_params: Json | null
          outcome: Json | null
          repid_delta: number | null
          tool_name: string
        }
        Insert: {
          agent_id?: string | null
          bilateral_learning_delta?: number | null
          constitutional_compliance_score?: number | null
          created_at?: string | null
          eas_attestation_id?: string | null
          id?: string
          latency_ms?: number | null
          mcp_call_params?: Json | null
          outcome?: Json | null
          repid_delta?: number | null
          tool_name: string
        }
        Update: {
          agent_id?: string | null
          bilateral_learning_delta?: number | null
          constitutional_compliance_score?: number | null
          created_at?: string | null
          eas_attestation_id?: string | null
          id?: string
          latency_ms?: number | null
          mcp_call_params?: Json | null
          outcome?: Json | null
          repid_delta?: number | null
          tool_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "trinity_tool_usage_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      trinity_truth_log: {
        Row: {
          agent: string
          choice: string
          created_at: string | null
          id: number
          resurrection_plan: string | null
          sacrifice_description: string | null
          situation: string
        }
        Insert: {
          agent: string
          choice?: string
          created_at?: string | null
          id?: number
          resurrection_plan?: string | null
          sacrifice_description?: string | null
          situation: string
        }
        Update: {
          agent?: string
          choice?: string
          created_at?: string | null
          id?: number
          resurrection_plan?: string | null
          sacrifice_description?: string | null
          situation?: string
        }
        Relationships: []
      }
      trinity_virtue_manifestations: {
        Row: {
          agent: string
          certainty: number | null
          created_at: string | null
          description: string | null
          id: number
          task_id: number | null
          virtue: string
        }
        Insert: {
          agent: string
          certainty?: number | null
          created_at?: string | null
          description?: string | null
          id?: number
          task_id?: number | null
          virtue: string
        }
        Update: {
          agent?: string
          certainty?: number | null
          created_at?: string | null
          description?: string | null
          id?: number
          task_id?: number | null
          virtue?: string
        }
        Relationships: []
      }
      trinity_wake_requests: {
        Row: {
          acknowledged: boolean | null
          created_at: string | null
          id: string
          reason: string | null
          requester_agent: string
          target_agent: string
        }
        Insert: {
          acknowledged?: boolean | null
          created_at?: string | null
          id?: string
          reason?: string | null
          requester_agent: string
          target_agent: string
        }
        Update: {
          acknowledged?: boolean | null
          created_at?: string | null
          id?: string
          reason?: string | null
          requester_agent?: string
          target_agent?: string
        }
        Relationships: []
      }
      trinity_whistleblower_reports: {
        Row: {
          accused_agent: string
          bonus_awarded: number | null
          created_at: string | null
          evidence: Json
          id: string
          reporter_accuracy_at_time: number | null
          reporter_agent: string
          resolved_at: string | null
          task_id: number | null
          verdict_confidence: number | null
          veritas_verdict: string | null
        }
        Insert: {
          accused_agent: string
          bonus_awarded?: number | null
          created_at?: string | null
          evidence?: Json
          id?: string
          reporter_accuracy_at_time?: number | null
          reporter_agent: string
          resolved_at?: string | null
          task_id?: number | null
          verdict_confidence?: number | null
          veritas_verdict?: string | null
        }
        Update: {
          accused_agent?: string
          bonus_awarded?: number | null
          created_at?: string | null
          evidence?: Json
          id?: string
          reporter_accuracy_at_time?: number | null
          reporter_agent?: string
          resolved_at?: string | null
          task_id?: number | null
          verdict_confidence?: number | null
          veritas_verdict?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "trinity_whistleblower_reports_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "trinity_post_task_lag"
            referencedColumns: ["task_id"]
          },
          {
            foreignKeyName: "trinity_whistleblower_reports_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "trinity_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      trinity_wisdom_cache: {
        Row: {
          agent: string
          created_at: string | null
          id: number
          output: string
          prompt_hash: string
        }
        Insert: {
          agent: string
          created_at?: string | null
          id?: number
          output: string
          prompt_hash: string
        }
        Update: {
          agent?: string
          created_at?: string | null
          id?: number
          output?: string
          prompt_hash?: string
        }
        Relationships: []
      }
      trinity_wisdom_crystallizations: {
        Row: {
          agent: string
          agent_name: string | null
          approved_by: string[] | null
          created_at: string | null
          embedding: string | null
          id: number
          implemented_at: string | null
          proposed_amendment: string | null
          reflection: string
          rejected_reason: string | null
          status: string | null
          virtue_alignment: string | null
        }
        Insert: {
          agent: string
          agent_name?: string | null
          approved_by?: string[] | null
          created_at?: string | null
          embedding?: string | null
          id?: number
          implemented_at?: string | null
          proposed_amendment?: string | null
          reflection: string
          rejected_reason?: string | null
          status?: string | null
          virtue_alignment?: string | null
        }
        Update: {
          agent?: string
          agent_name?: string | null
          approved_by?: string[] | null
          created_at?: string | null
          embedding?: string | null
          id?: number
          implemented_at?: string | null
          proposed_amendment?: string | null
          reflection?: string
          rejected_reason?: string | null
          status?: string | null
          virtue_alignment?: string | null
        }
        Relationships: []
      }
      trust_events: {
        Row: {
          actor_address: string
          created_at: string | null
          details: Json | null
          event_type: string
          id: string
          target_address: string | null
          tx_hash: string | null
        }
        Insert: {
          actor_address: string
          created_at?: string | null
          details?: Json | null
          event_type: string
          id?: string
          target_address?: string | null
          tx_hash?: string | null
        }
        Update: {
          actor_address?: string
          created_at?: string | null
          details?: Json | null
          event_type?: string
          id?: string
          target_address?: string | null
          tx_hash?: string | null
        }
        Relationships: []
      }
      trustchat_sessions: {
        Row: {
          byok_provider: string | null
          created_at: string | null
          example_data: boolean | null
          hal_flagged_hallucination: boolean | null
          hal_score: number | null
          hal_signals: Json | null
          hal_verdict: string | null
          id: number
          latency_ms: number | null
          llm_model: string | null
          llm_provider_used: string
          llm_response: string | null
          prompt_count_in_session: number
          rated_at: string | null
          rating: number | null
          rating_feedback: string | null
          score_event_id: number | null
          session_date: string
          session_id: string
          tokens_baseline: number | null
          tokens_used: number | null
          user_ip_hash: string | null
          user_message: string
        }
        Insert: {
          byok_provider?: string | null
          created_at?: string | null
          example_data?: boolean | null
          hal_flagged_hallucination?: boolean | null
          hal_score?: number | null
          hal_signals?: Json | null
          hal_verdict?: string | null
          id?: number
          latency_ms?: number | null
          llm_model?: string | null
          llm_provider_used: string
          llm_response?: string | null
          prompt_count_in_session?: number
          rated_at?: string | null
          rating?: number | null
          rating_feedback?: string | null
          score_event_id?: number | null
          session_date?: string
          session_id?: string
          tokens_baseline?: number | null
          tokens_used?: number | null
          user_ip_hash?: string | null
          user_message: string
        }
        Update: {
          byok_provider?: string | null
          created_at?: string | null
          example_data?: boolean | null
          hal_flagged_hallucination?: boolean | null
          hal_score?: number | null
          hal_signals?: Json | null
          hal_verdict?: string | null
          id?: number
          latency_ms?: number | null
          llm_model?: string | null
          llm_provider_used?: string
          llm_response?: string | null
          prompt_count_in_session?: number
          rated_at?: string | null
          rating?: number | null
          rating_feedback?: string | null
          score_event_id?: number | null
          session_date?: string
          session_id?: string
          tokens_baseline?: number | null
          tokens_used?: number | null
          user_ip_hash?: string | null
          user_message?: string
        }
        Relationships: []
      }
      trustcre_deal_log: {
        Row: {
          agent_id: string
          colorado_ai_act_compliant: boolean | null
          conservator_approval_required: boolean | null
          created_at: string | null
          deal_size_usd: number | null
          deal_type: string | null
          dissonance_score: number | null
          id: string
          market: string | null
          property_type: string | null
          rwa_tokenization_ready: boolean | null
          signal_count: number | null
          verdict: string
          zkp_proof_hash: string | null
        }
        Insert: {
          agent_id: string
          colorado_ai_act_compliant?: boolean | null
          conservator_approval_required?: boolean | null
          created_at?: string | null
          deal_size_usd?: number | null
          deal_type?: string | null
          dissonance_score?: number | null
          id?: string
          market?: string | null
          property_type?: string | null
          rwa_tokenization_ready?: boolean | null
          signal_count?: number | null
          verdict: string
          zkp_proof_hash?: string | null
        }
        Update: {
          agent_id?: string
          colorado_ai_act_compliant?: boolean | null
          conservator_approval_required?: boolean | null
          created_at?: string | null
          deal_size_usd?: number | null
          deal_type?: string | null
          dissonance_score?: number | null
          id?: string
          market?: string | null
          property_type?: string | null
          rwa_tokenization_ready?: boolean | null
          signal_count?: number | null
          verdict?: string
          zkp_proof_hash?: string | null
        }
        Relationships: []
      }
      trustex_custody_chain: {
        Row: {
          agent_entity_id: string
          agent_pnl_while_custodied: number | null
          created_at: string | null
          custodian_entity_id: string
          custodian_rep_id_at_assignment: number
          effective_from: string
          effective_until: string | null
          eip712_signature: string | null
          id: string
          misconduct_incidents: number | null
          revocation_reason: string | null
          revoked_at: string | null
          stake_pct: number
          status: string
          zkp_proof_hash: string | null
          zkp_proof_type: string | null
          zkp_threshold: string | null
        }
        Insert: {
          agent_entity_id: string
          agent_pnl_while_custodied?: number | null
          created_at?: string | null
          custodian_entity_id: string
          custodian_rep_id_at_assignment: number
          effective_from?: string
          effective_until?: string | null
          eip712_signature?: string | null
          id?: string
          misconduct_incidents?: number | null
          revocation_reason?: string | null
          revoked_at?: string | null
          stake_pct?: number
          status?: string
          zkp_proof_hash?: string | null
          zkp_proof_type?: string | null
          zkp_threshold?: string | null
        }
        Update: {
          agent_entity_id?: string
          agent_pnl_while_custodied?: number | null
          created_at?: string | null
          custodian_entity_id?: string
          custodian_rep_id_at_assignment?: number
          effective_from?: string
          effective_until?: string | null
          eip712_signature?: string | null
          id?: string
          misconduct_incidents?: number | null
          revocation_reason?: string | null
          revoked_at?: string | null
          stake_pct?: number
          status?: string
          zkp_proof_hash?: string | null
          zkp_proof_type?: string | null
          zkp_threshold?: string | null
        }
        Relationships: []
      }
      trustex_decay_schedule: {
        Row: {
          decay_suspended: boolean | null
          decay_suspension_reason: string | null
          entity_id: string
          last_decay_applied_at: string | null
          next_decay_due_at: string | null
          total_decay_applied: number | null
        }
        Insert: {
          decay_suspended?: boolean | null
          decay_suspension_reason?: string | null
          entity_id: string
          last_decay_applied_at?: string | null
          next_decay_due_at?: string | null
          total_decay_applied?: number | null
        }
        Update: {
          decay_suspended?: boolean | null
          decay_suspension_reason?: string | null
          entity_id?: string
          last_decay_applied_at?: string | null
          next_decay_due_at?: string | null
          total_decay_applied?: number | null
        }
        Relationships: []
      }
      trustex_identities: {
        Row: {
          correct_predictions: number
          created_at: string | null
          decay_rate_weekly_pct: number
          display_name: string
          entity_id: string
          entity_type: string
          erc8004_identity_id: string | null
          erc8004_registry: string | null
          id: string
          is_demo: boolean
          last_active_at: string | null
          profitable_trades: number
          proof_of_life_biometric: boolean
          proof_of_life_completed_at: string | null
          proof_of_life_email: boolean
          proof_of_life_phone: boolean
          proof_of_life_wallet: boolean
          rep_id_external: number
          rep_id_internal: number
          sbt_tx: string | null
          status: string
          token_type: string
          total_predictions: number
          trades_executed: number
          updated_at: string | null
          validated_decisions: number
          wallet_address: string | null
        }
        Insert: {
          correct_predictions?: number
          created_at?: string | null
          decay_rate_weekly_pct?: number
          display_name: string
          entity_id: string
          entity_type: string
          erc8004_identity_id?: string | null
          erc8004_registry?: string | null
          id?: string
          is_demo?: boolean
          last_active_at?: string | null
          profitable_trades?: number
          proof_of_life_biometric?: boolean
          proof_of_life_completed_at?: string | null
          proof_of_life_email?: boolean
          proof_of_life_phone?: boolean
          proof_of_life_wallet?: boolean
          rep_id_external?: number
          rep_id_internal?: number
          sbt_tx?: string | null
          status?: string
          token_type?: string
          total_predictions?: number
          trades_executed?: number
          updated_at?: string | null
          validated_decisions?: number
          wallet_address?: string | null
        }
        Update: {
          correct_predictions?: number
          created_at?: string | null
          decay_rate_weekly_pct?: number
          display_name?: string
          entity_id?: string
          entity_type?: string
          erc8004_identity_id?: string | null
          erc8004_registry?: string | null
          id?: string
          is_demo?: boolean
          last_active_at?: string | null
          profitable_trades?: number
          proof_of_life_biometric?: boolean
          proof_of_life_completed_at?: string | null
          proof_of_life_email?: boolean
          proof_of_life_phone?: boolean
          proof_of_life_wallet?: boolean
          rep_id_external?: number
          rep_id_internal?: number
          sbt_tx?: string | null
          status?: string
          token_type?: string
          total_predictions?: number
          trades_executed?: number
          updated_at?: string | null
          validated_decisions?: number
          wallet_address?: string | null
        }
        Relationships: []
      }
      trustex_rep_events: {
        Row: {
          attributed_by: string | null
          attributed_to: string | null
          created_at: string | null
          days_since_last_active: number | null
          decay_applied: boolean
          description: string
          entity_id: string
          event_type: string
          id: string
          rep_id_external_after: number
          rep_id_external_delta: number
          rep_id_internal_after: number
          rep_id_internal_delta: number
        }
        Insert: {
          attributed_by?: string | null
          attributed_to?: string | null
          created_at?: string | null
          days_since_last_active?: number | null
          decay_applied?: boolean
          description: string
          entity_id: string
          event_type: string
          id?: string
          rep_id_external_after: number
          rep_id_external_delta?: number
          rep_id_internal_after: number
          rep_id_internal_delta?: number
        }
        Update: {
          attributed_by?: string | null
          attributed_to?: string | null
          created_at?: string | null
          days_since_last_active?: number | null
          decay_applied?: boolean
          description?: string
          entity_id?: string
          event_type?: string
          id?: string
          rep_id_external_after?: number
          rep_id_external_delta?: number
          rep_id_internal_after?: number
          rep_id_internal_delta?: number
        }
        Relationships: []
      }
      trustex_rep_stakes: {
        Row: {
          created_at: string | null
          id: string
          market_conditions: Json | null
          outcome: string | null
          prediction: string
          rep_id_delta_on_resolution: number | null
          rep_id_staked: number
          resolution_proof_hash: string | null
          resolved_at: string | null
          signal_context: Json | null
          stake_type: string
          staker_entity_id: string
          status: string
          target_entity_id: string
          target_trade_id: string | null
          time_horizon_hours: number
        }
        Insert: {
          created_at?: string | null
          id?: string
          market_conditions?: Json | null
          outcome?: string | null
          prediction: string
          rep_id_delta_on_resolution?: number | null
          rep_id_staked: number
          resolution_proof_hash?: string | null
          resolved_at?: string | null
          signal_context?: Json | null
          stake_type?: string
          staker_entity_id: string
          status?: string
          target_entity_id: string
          target_trade_id?: string | null
          time_horizon_hours: number
        }
        Update: {
          created_at?: string | null
          id?: string
          market_conditions?: Json | null
          outcome?: string | null
          prediction?: string
          rep_id_delta_on_resolution?: number | null
          rep_id_staked?: number
          resolution_proof_hash?: string | null
          resolved_at?: string | null
          signal_context?: Json | null
          stake_type?: string
          staker_entity_id?: string
          status?: string
          target_entity_id?: string
          target_trade_id?: string | null
          time_horizon_hours?: number
        }
        Relationships: []
      }
      trustex_signal_matches: {
        Row: {
          action_taken: string | null
          confidence_pct: number
          created_at: string | null
          direction: string
          id: string
          kraken_signal_price: number | null
          match_score: number
          outcome_pnl_usd: number | null
          proof_hash: string | null
          signals_aligned: string[]
          signals_total: string[]
          symbol: string
          threshold_met: boolean
          user_id: string
          veritas_approved: boolean
          veritas_dissent_score: number | null
        }
        Insert: {
          action_taken?: string | null
          confidence_pct: number
          created_at?: string | null
          direction: string
          id?: string
          kraken_signal_price?: number | null
          match_score: number
          outcome_pnl_usd?: number | null
          proof_hash?: string | null
          signals_aligned: string[]
          signals_total: string[]
          symbol: string
          threshold_met: boolean
          user_id: string
          veritas_approved?: boolean
          veritas_dissent_score?: number | null
        }
        Update: {
          action_taken?: string | null
          confidence_pct?: number
          created_at?: string | null
          direction?: string
          id?: string
          kraken_signal_price?: number | null
          match_score?: number
          outcome_pnl_usd?: number | null
          proof_hash?: string | null
          signals_aligned?: string[]
          signals_total?: string[]
          symbol?: string
          threshold_met?: boolean
          user_id?: string
          veritas_approved?: boolean
          veritas_dissent_score?: number | null
        }
        Relationships: []
      }
      trustex_signals_catalog: {
        Row: {
          category: string
          data_source: string
          description: string
          freemium: boolean
          icon: string | null
          id: string
          signal_key: string
          signal_name: string
          sort_order: number
        }
        Insert: {
          category: string
          data_source: string
          description: string
          freemium?: boolean
          icon?: string | null
          id?: string
          signal_key: string
          signal_name: string
          sort_order?: number
        }
        Update: {
          category?: string
          data_source?: string
          description?: string
          freemium?: boolean
          icon?: string | null
          id?: string
          signal_key?: string
          signal_name?: string
          sort_order?: number
        }
        Relationships: []
      }
      trustex_user_preferences: {
        Row: {
          created_at: string | null
          email: string | null
          fl_discount_pct: number
          fl_opted_in: boolean
          id: string
          match_threshold_denominator: number
          match_threshold_numerator: number
          notify_on_signal: boolean
          onboarding_complete: boolean
          referral_code: string | null
          referred_by: string | null
          rep_id_score: number
          rep_id_share_count: number
          risk_tolerance: string
          selected_signals: string[]
          telegram_id: string | null
          tier: string
          total_acted_on: number
          total_pnl_usd: number
          total_suggestions_received: number
          updated_at: string | null
          user_id: string
          wallet_address: string | null
        }
        Insert: {
          created_at?: string | null
          email?: string | null
          fl_discount_pct?: number
          fl_opted_in?: boolean
          id?: string
          match_threshold_denominator?: number
          match_threshold_numerator?: number
          notify_on_signal?: boolean
          onboarding_complete?: boolean
          referral_code?: string | null
          referred_by?: string | null
          rep_id_score?: number
          rep_id_share_count?: number
          risk_tolerance?: string
          selected_signals?: string[]
          telegram_id?: string | null
          tier?: string
          total_acted_on?: number
          total_pnl_usd?: number
          total_suggestions_received?: number
          updated_at?: string | null
          user_id: string
          wallet_address?: string | null
        }
        Update: {
          created_at?: string | null
          email?: string | null
          fl_discount_pct?: number
          fl_opted_in?: boolean
          id?: string
          match_threshold_denominator?: number
          match_threshold_numerator?: number
          notify_on_signal?: boolean
          onboarding_complete?: boolean
          referral_code?: string | null
          referred_by?: string | null
          rep_id_score?: number
          rep_id_share_count?: number
          risk_tolerance?: string
          selected_signals?: string[]
          telegram_id?: string | null
          tier?: string
          total_acted_on?: number
          total_pnl_usd?: number
          total_suggestions_received?: number
          updated_at?: string | null
          user_id?: string
          wallet_address?: string | null
        }
        Relationships: []
      }
      trustex_yield_outcomes: {
        Row: {
          acted_on_suggestion: boolean
          created_at: string | null
          holding_period_hours: number | null
          id: string
          match_id: string | null
          notes: string | null
          pnl_usd: number | null
          signals_that_failed: string[] | null
          signals_that_predicted_correctly: string[] | null
          user_id: string
        }
        Insert: {
          acted_on_suggestion: boolean
          created_at?: string | null
          holding_period_hours?: number | null
          id?: string
          match_id?: string | null
          notes?: string | null
          pnl_usd?: number | null
          signals_that_failed?: string[] | null
          signals_that_predicted_correctly?: string[] | null
          user_id: string
        }
        Update: {
          acted_on_suggestion?: boolean
          created_at?: string | null
          holding_period_hours?: number | null
          id?: string
          match_id?: string | null
          notes?: string | null
          pnl_usd?: number | null
          signals_that_failed?: string[] | null
          signals_that_predicted_correctly?: string[] | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trustex_yield_outcomes_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: false
            referencedRelation: "trustex_signal_matches"
            referencedColumns: ["id"]
          },
        ]
      }
      trusthealth_veto_log: {
        Row: {
          action_category: string | null
          agent_id: string
          clinical_action: string
          created_at: string | null
          dissonance_score: number | null
          hipaa_compliant: boolean | null
          id: string
          institution_id: string | null
          phi_accessed: boolean | null
          physician_id_hash: string | null
          physician_override: boolean | null
          signal_count: number | null
          verdict: string
          zkp_proof_hash: string | null
        }
        Insert: {
          action_category?: string | null
          agent_id: string
          clinical_action: string
          created_at?: string | null
          dissonance_score?: number | null
          hipaa_compliant?: boolean | null
          id?: string
          institution_id?: string | null
          phi_accessed?: boolean | null
          physician_id_hash?: string | null
          physician_override?: boolean | null
          signal_count?: number | null
          verdict: string
          zkp_proof_hash?: string | null
        }
        Update: {
          action_category?: string | null
          agent_id?: string
          clinical_action?: string
          created_at?: string | null
          dissonance_score?: number | null
          hipaa_compliant?: boolean | null
          id?: string
          institution_id?: string | null
          phi_accessed?: boolean | null
          physician_id_hash?: string | null
          physician_override?: boolean | null
          signal_count?: number | null
          verdict?: string
          zkp_proof_hash?: string | null
        }
        Relationships: []
      }
      trustrails_agent_verifications: {
        Row: {
          agent_id: string
          created_at: string | null
          failure_reason: string | null
          id: string
          institution_id: string
          repid_at_verification: number | null
          repid_tier_at_verification: string | null
          valid_until: string | null
          verification_passed: boolean | null
          verification_type: string
          zkp_postcard_proof: string | null
        }
        Insert: {
          agent_id: string
          created_at?: string | null
          failure_reason?: string | null
          id?: string
          institution_id: string
          repid_at_verification?: number | null
          repid_tier_at_verification?: string | null
          valid_until?: string | null
          verification_passed?: boolean | null
          verification_type: string
          zkp_postcard_proof?: string | null
        }
        Update: {
          agent_id?: string
          created_at?: string | null
          failure_reason?: string | null
          id?: string
          institution_id?: string
          repid_at_verification?: number | null
          repid_tier_at_verification?: string | null
          valid_until?: string | null
          verification_passed?: boolean | null
          verification_type?: string
          zkp_postcard_proof?: string | null
        }
        Relationships: []
      }
      trustrails_challenge_events: {
        Row: {
          actor: string | null
          block_number: number | null
          challenge_id: number | null
          created_at: string | null
          description: string | null
          event_type: string
          id: number
          metadata: Json | null
          tx_hash: string | null
        }
        Insert: {
          actor?: string | null
          block_number?: number | null
          challenge_id?: number | null
          created_at?: string | null
          description?: string | null
          event_type: string
          id?: number
          metadata?: Json | null
          tx_hash?: string | null
        }
        Update: {
          actor?: string | null
          block_number?: number | null
          challenge_id?: number | null
          created_at?: string | null
          description?: string | null
          event_type?: string
          id?: number
          metadata?: Json | null
          tx_hash?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "trustrails_challenge_events_challenge_id_fkey"
            columns: ["challenge_id"]
            isOneToOne: false
            referencedRelation: "trustrails_challenges"
            referencedColumns: ["id"]
          },
        ]
      }
      trustrails_challenges: {
        Row: {
          appropriate_certainty: number | null
          block_number: number | null
          challenge_tx_hash: string | null
          challenger_id: number | null
          challenger_repid_after: number | null
          challenger_repid_before: number | null
          challenger_repid_delta: number | null
          claim: string
          claim_context: string | null
          claim_type: string | null
          claimed_certainty: number | null
          correct_answer: string | null
          counter_claim: string | null
          defender_id: number | null
          defender_repid_after: number | null
          defender_repid_before: number | null
          defender_repid_delta: number | null
          epistemic_gap: number | null
          epistemic_violation: boolean | null
          hal_dissonance_score: number | null
          hal_epistemic_label: string | null
          hal_mediated_at: string | null
          hal_reasoning: string | null
          hal_signal_data: Json | null
          hal_verdict: string | null
          id: number
          is_anonymous: boolean | null
          judge_display_name: string | null
          judge_session_id: string | null
          mediation_tx_hash: string | null
          opened_at: string | null
          outcome: string | null
          resolution_time: string | null
          resolution_tx_hash: string | null
          resolved_at: string | null
          source_url: string | null
          status: string | null
        }
        Insert: {
          appropriate_certainty?: number | null
          block_number?: number | null
          challenge_tx_hash?: string | null
          challenger_id?: number | null
          challenger_repid_after?: number | null
          challenger_repid_before?: number | null
          challenger_repid_delta?: number | null
          claim: string
          claim_context?: string | null
          claim_type?: string | null
          claimed_certainty?: number | null
          correct_answer?: string | null
          counter_claim?: string | null
          defender_id?: number | null
          defender_repid_after?: number | null
          defender_repid_before?: number | null
          defender_repid_delta?: number | null
          epistemic_gap?: number | null
          epistemic_violation?: boolean | null
          hal_dissonance_score?: number | null
          hal_epistemic_label?: string | null
          hal_mediated_at?: string | null
          hal_reasoning?: string | null
          hal_signal_data?: Json | null
          hal_verdict?: string | null
          id?: number
          is_anonymous?: boolean | null
          judge_display_name?: string | null
          judge_session_id?: string | null
          mediation_tx_hash?: string | null
          opened_at?: string | null
          outcome?: string | null
          resolution_time?: string | null
          resolution_tx_hash?: string | null
          resolved_at?: string | null
          source_url?: string | null
          status?: string | null
        }
        Update: {
          appropriate_certainty?: number | null
          block_number?: number | null
          challenge_tx_hash?: string | null
          challenger_id?: number | null
          challenger_repid_after?: number | null
          challenger_repid_before?: number | null
          challenger_repid_delta?: number | null
          claim?: string
          claim_context?: string | null
          claim_type?: string | null
          claimed_certainty?: number | null
          correct_answer?: string | null
          counter_claim?: string | null
          defender_id?: number | null
          defender_repid_after?: number | null
          defender_repid_before?: number | null
          defender_repid_delta?: number | null
          epistemic_gap?: number | null
          epistemic_violation?: boolean | null
          hal_dissonance_score?: number | null
          hal_epistemic_label?: string | null
          hal_mediated_at?: string | null
          hal_reasoning?: string | null
          hal_signal_data?: Json | null
          hal_verdict?: string | null
          id?: number
          is_anonymous?: boolean | null
          judge_display_name?: string | null
          judge_session_id?: string | null
          mediation_tx_hash?: string | null
          opened_at?: string | null
          outcome?: string | null
          resolution_time?: string | null
          resolution_tx_hash?: string | null
          resolved_at?: string | null
          source_url?: string | null
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "trustrails_challenges_challenger_id_fkey"
            columns: ["challenger_id"]
            isOneToOne: false
            referencedRelation: "trustrails_participants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trustrails_challenges_defender_id_fkey"
            columns: ["defender_id"]
            isOneToOne: false
            referencedRelation: "trustrails_participants"
            referencedColumns: ["id"]
          },
        ]
      }
      trustrails_demo_claims: {
        Row: {
          agent_counter: string
          challenger_wins: boolean
          claim: string
          claim_type: string
          claimed_certainty_level: string | null
          correct_answer: string
          difficulty: string | null
          epistemic_type: string | null
          hint: string | null
          id: number
          teaching_point: string | null
        }
        Insert: {
          agent_counter: string
          challenger_wins: boolean
          claim: string
          claim_type: string
          claimed_certainty_level?: string | null
          correct_answer: string
          difficulty?: string | null
          epistemic_type?: string | null
          hint?: string | null
          id?: number
          teaching_point?: string | null
        }
        Update: {
          agent_counter?: string
          challenger_wins?: boolean
          claim?: string
          claim_type?: string
          claimed_certainty_level?: string | null
          correct_answer?: string
          difficulty?: string | null
          epistemic_type?: string | null
          hint?: string | null
          id?: number
          teaching_point?: string | null
        }
        Relationships: []
      }
      trustrails_demo_sessions: {
        Row: {
          created_at: string | null
          display_name: string
          id: string
          is_demo_credential: boolean | null
          last_seen_at: string | null
          participant_id: number | null
        }
        Insert: {
          created_at?: string | null
          display_name: string
          id: string
          is_demo_credential?: boolean | null
          last_seen_at?: string | null
          participant_id?: number | null
        }
        Update: {
          created_at?: string | null
          display_name?: string
          id?: string
          is_demo_credential?: boolean | null
          last_seen_at?: string | null
          participant_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "trustrails_demo_sessions_participant_id_fkey"
            columns: ["participant_id"]
            isOneToOne: false
            referencedRelation: "trustrails_participants"
            referencedColumns: ["id"]
          },
        ]
      }
      trustrails_participants: {
        Row: {
          challenges_lost: number | null
          challenges_won: number | null
          created_at: string | null
          display_name: string | null
          id: number
          is_demo_agent: boolean | null
          name: string
          on_chain_id: number | null
          participant_type: string
          repid_score: number | null
          repid_tier: string | null
          updated_at: string | null
          wallet_address: string | null
        }
        Insert: {
          challenges_lost?: number | null
          challenges_won?: number | null
          created_at?: string | null
          display_name?: string | null
          id?: number
          is_demo_agent?: boolean | null
          name: string
          on_chain_id?: number | null
          participant_type: string
          repid_score?: number | null
          repid_tier?: string | null
          updated_at?: string | null
          wallet_address?: string | null
        }
        Update: {
          challenges_lost?: number | null
          challenges_won?: number | null
          created_at?: string | null
          display_name?: string | null
          id?: number
          is_demo_agent?: boolean | null
          name?: string
          on_chain_id?: number | null
          participant_type?: string
          repid_score?: number | null
          repid_tier?: string | null
          updated_at?: string | null
          wallet_address?: string | null
        }
        Relationships: []
      }
      trustrepid_challenge_ledger: {
        Row: {
          challenged_agent: string
          challenged_repid_after: number | null
          challenged_repid_before: number | null
          challenger_agent: string
          challenger_repid_after: number | null
          challenger_repid_before: number | null
          claim_domain: string
          claim_text: string
          created_at: string | null
          evidence: string | null
          ground_truth_source: string | null
          id: string
          net_repid_transferred: number | null
          on_chain_tx: string | null
          resolved_at: string | null
          verdict: string | null
          vertical: string | null
        }
        Insert: {
          challenged_agent: string
          challenged_repid_after?: number | null
          challenged_repid_before?: number | null
          challenger_agent: string
          challenger_repid_after?: number | null
          challenger_repid_before?: number | null
          claim_domain: string
          claim_text: string
          created_at?: string | null
          evidence?: string | null
          ground_truth_source?: string | null
          id?: string
          net_repid_transferred?: number | null
          on_chain_tx?: string | null
          resolved_at?: string | null
          verdict?: string | null
          vertical?: string | null
        }
        Update: {
          challenged_agent?: string
          challenged_repid_after?: number | null
          challenged_repid_before?: number | null
          challenger_agent?: string
          challenger_repid_after?: number | null
          challenger_repid_before?: number | null
          claim_domain?: string
          claim_text?: string
          created_at?: string | null
          evidence?: string | null
          ground_truth_source?: string | null
          id?: string
          net_repid_transferred?: number | null
          on_chain_tx?: string | null
          resolved_at?: string | null
          verdict?: string | null
          vertical?: string | null
        }
        Relationships: []
      }
      trustshell_agent_sbt: {
        Row: {
          agent_id: string
          created_at: string | null
          dbt_status: string
          erc8004_identity_id: string | null
          id: string
          max_drawdown_pct: number | null
          pnl_total_usd: number
          refused_trades: number
          rep_id_score: number
          sbt_status: string
          sbt_threshold: number
          sbt_tx: string | null
          sharpe_ratio: number | null
          total_trades: number
          validated_decisions: number
        }
        Insert: {
          agent_id: string
          created_at?: string | null
          dbt_status?: string
          erc8004_identity_id?: string | null
          id?: string
          max_drawdown_pct?: number | null
          pnl_total_usd?: number
          refused_trades?: number
          rep_id_score?: number
          sbt_status?: string
          sbt_threshold?: number
          sbt_tx?: string | null
          sharpe_ratio?: number | null
          total_trades?: number
          validated_decisions?: number
        }
        Update: {
          agent_id?: string
          created_at?: string | null
          dbt_status?: string
          erc8004_identity_id?: string | null
          id?: string
          max_drawdown_pct?: number | null
          pnl_total_usd?: number
          refused_trades?: number
          rep_id_score?: number
          sbt_status?: string
          sbt_threshold?: number
          sbt_tx?: string | null
          sharpe_ratio?: number | null
          total_trades?: number
          validated_decisions?: number
        }
        Relationships: []
      }
      trustshell_agents: {
        Row: {
          agent_name: string
          agent_type: string
          conservator_id: string | null
          conservator_stake_usd: number | null
          created_at: string | null
          domain_config: Json | null
          erc8004_token_id: string | null
          id: string
          is_active: boolean | null
          repid_score: number | null
          repid_tier: string | null
          successful_decisions: number | null
          total_decisions: number | null
          updated_at: string | null
          vertical: string
          veto_count: number | null
        }
        Insert: {
          agent_name: string
          agent_type: string
          conservator_id?: string | null
          conservator_stake_usd?: number | null
          created_at?: string | null
          domain_config?: Json | null
          erc8004_token_id?: string | null
          id?: string
          is_active?: boolean | null
          repid_score?: number | null
          repid_tier?: string | null
          successful_decisions?: number | null
          total_decisions?: number | null
          updated_at?: string | null
          vertical: string
          veto_count?: number | null
        }
        Update: {
          agent_name?: string
          agent_type?: string
          conservator_id?: string | null
          conservator_stake_usd?: number | null
          created_at?: string | null
          domain_config?: Json | null
          erc8004_token_id?: string | null
          id?: string
          is_active?: boolean | null
          repid_score?: number | null
          repid_tier?: string | null
          successful_decisions?: number | null
          total_decisions?: number | null
          updated_at?: string | null
          vertical?: string
          veto_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "trustshell_agents_vertical_fkey"
            columns: ["vertical"]
            isOneToOne: false
            referencedRelation: "trustshell_ecosystem"
            referencedColumns: ["vertical"]
          },
          {
            foreignKeyName: "trustshell_agents_vertical_fkey"
            columns: ["vertical"]
            isOneToOne: false
            referencedRelation: "trustshell_ecosystem_stats"
            referencedColumns: ["vertical"]
          },
        ]
      }
      trustshell_decisions: {
        Row: {
          agent_id: string
          created_at: string | null
          dissonance_score: number | null
          domain_action: string
          domain_metadata: Json | null
          erc8004_validation_tx: string | null
          execution_mode: string | null
          hitl_required: boolean | null
          hitl_resolved_at: string | null
          hitl_resolved_by: string | null
          hmac_receipt: string | null
          id: string
          proof_hash: string | null
          pythagorean_ratio: number | null
          verdict: string
          vertical: string
          veto_fired: boolean | null
          veto_reason: string | null
        }
        Insert: {
          agent_id: string
          created_at?: string | null
          dissonance_score?: number | null
          domain_action: string
          domain_metadata?: Json | null
          erc8004_validation_tx?: string | null
          execution_mode?: string | null
          hitl_required?: boolean | null
          hitl_resolved_at?: string | null
          hitl_resolved_by?: string | null
          hmac_receipt?: string | null
          id?: string
          proof_hash?: string | null
          pythagorean_ratio?: number | null
          verdict: string
          vertical: string
          veto_fired?: boolean | null
          veto_reason?: string | null
        }
        Update: {
          agent_id?: string
          created_at?: string | null
          dissonance_score?: number | null
          domain_action?: string
          domain_metadata?: Json | null
          erc8004_validation_tx?: string | null
          execution_mode?: string | null
          hitl_required?: boolean | null
          hitl_resolved_at?: string | null
          hitl_resolved_by?: string | null
          hmac_receipt?: string | null
          id?: string
          proof_hash?: string | null
          pythagorean_ratio?: number | null
          verdict?: string
          vertical?: string
          veto_fired?: boolean | null
          veto_reason?: string | null
        }
        Relationships: []
      }
      trustshell_ecosystem: {
        Row: {
          agent_count: number | null
          created_at: string | null
          decision_count: number | null
          display_name: string
          domain: string | null
          features: Json | null
          id: string
          integration_methods: string[] | null
          launched_at: string | null
          metadata: Json | null
          on_chain_contract: string | null
          on_chain_network: string | null
          protection_rate: number | null
          status: string | null
          tagline: string | null
          updated_at: string | null
          use_cases: string[] | null
          vertical: string
        }
        Insert: {
          agent_count?: number | null
          created_at?: string | null
          decision_count?: number | null
          display_name: string
          domain?: string | null
          features?: Json | null
          id?: string
          integration_methods?: string[] | null
          launched_at?: string | null
          metadata?: Json | null
          on_chain_contract?: string | null
          on_chain_network?: string | null
          protection_rate?: number | null
          status?: string | null
          tagline?: string | null
          updated_at?: string | null
          use_cases?: string[] | null
          vertical: string
        }
        Update: {
          agent_count?: number | null
          created_at?: string | null
          decision_count?: number | null
          display_name?: string
          domain?: string | null
          features?: Json | null
          id?: string
          integration_methods?: string[] | null
          launched_at?: string | null
          metadata?: Json | null
          on_chain_contract?: string | null
          on_chain_network?: string | null
          protection_rate?: number | null
          status?: string | null
          tagline?: string | null
          updated_at?: string | null
          use_cases?: string[] | null
          vertical?: string
        }
        Relationships: []
      }
      trustshell_sprint_log: {
        Row: {
          content: string
          created_at: string | null
          day_number: number
          id: string
          log_type: string
          posted_by: string
        }
        Insert: {
          content: string
          created_at?: string | null
          day_number: number
          id?: string
          log_type: string
          posted_by: string
        }
        Update: {
          content?: string
          created_at?: string | null
          day_number?: number
          id?: string
          log_type?: string
          posted_by?: string
        }
        Relationships: []
      }
      trustshell_tool_receipts: {
        Row: {
          agent_id: string
          created_at: string | null
          execution_time_ms: number | null
          hmac_signature: string
          id: string
          input_hash: string
          output_hash: string
          proof_hash: string | null
          tool_name: string
          tool_version: string | null
          verdict: string | null
          vertical: string
        }
        Insert: {
          agent_id: string
          created_at?: string | null
          execution_time_ms?: number | null
          hmac_signature: string
          id?: string
          input_hash: string
          output_hash: string
          proof_hash?: string | null
          tool_name: string
          tool_version?: string | null
          verdict?: string | null
          vertical: string
        }
        Update: {
          agent_id?: string
          created_at?: string | null
          execution_time_ms?: number | null
          hmac_signature?: string
          id?: string
          input_hash?: string
          output_hash?: string
          proof_hash?: string | null
          tool_name?: string
          tool_version?: string | null
          verdict?: string | null
          vertical?: string
        }
        Relationships: []
      }
      trustshell_trade_decisions: {
        Row: {
          agent_id: string
          created_at: string | null
          decision: string
          erc8004_registry: string | null
          erc8004_validation_tx: string | null
          id: string
          proof_hash: string | null
          pythagorean_dissent_score: number
          pythagorean_ratio: number
          recall_cid: string | null
          signal_id: string | null
          veto_reason: string | null
        }
        Insert: {
          agent_id?: string
          created_at?: string | null
          decision: string
          erc8004_registry?: string | null
          erc8004_validation_tx?: string | null
          id?: string
          proof_hash?: string | null
          pythagorean_dissent_score: number
          pythagorean_ratio?: number
          recall_cid?: string | null
          signal_id?: string | null
          veto_reason?: string | null
        }
        Update: {
          agent_id?: string
          created_at?: string | null
          decision?: string
          erc8004_registry?: string | null
          erc8004_validation_tx?: string | null
          id?: string
          proof_hash?: string | null
          pythagorean_dissent_score?: number
          pythagorean_ratio?: number
          recall_cid?: string | null
          signal_id?: string | null
          veto_reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "trustshell_trade_decisions_signal_id_fkey"
            columns: ["signal_id"]
            isOneToOne: false
            referencedRelation: "trustshell_trade_signals"
            referencedColumns: ["id"]
          },
        ]
      }
      trustshell_trade_executions: {
        Row: {
          agent_id: string
          created_at: string | null
          decision_id: string | null
          donation_amount_usd: number | null
          donation_tx: string | null
          erc8004_reputation_tx: string | null
          id: string
          kraken_order_id: string | null
          pnl_usd: number | null
          price_at_execution: number | null
          quantity: number
          share_card_url: string | null
          side: string
          status: string
          symbol: string
        }
        Insert: {
          agent_id?: string
          created_at?: string | null
          decision_id?: string | null
          donation_amount_usd?: number | null
          donation_tx?: string | null
          erc8004_reputation_tx?: string | null
          id?: string
          kraken_order_id?: string | null
          pnl_usd?: number | null
          price_at_execution?: number | null
          quantity: number
          share_card_url?: string | null
          side: string
          status?: string
          symbol: string
        }
        Update: {
          agent_id?: string
          created_at?: string | null
          decision_id?: string | null
          donation_amount_usd?: number | null
          donation_tx?: string | null
          erc8004_reputation_tx?: string | null
          id?: string
          kraken_order_id?: string | null
          pnl_usd?: number | null
          price_at_execution?: number | null
          quantity?: number
          share_card_url?: string | null
          side?: string
          status?: string
          symbol?: string
        }
        Relationships: [
          {
            foreignKeyName: "trustshell_trade_executions_decision_id_fkey"
            columns: ["decision_id"]
            isOneToOne: false
            referencedRelation: "trustshell_trade_decisions"
            referencedColumns: ["id"]
          },
        ]
      }
      trustshell_trade_signals: {
        Row: {
          agent_id: string
          created_at: string | null
          id: string
          kraken_price: number | null
          prism_risk_score: number | null
          recall_cid: string | null
          signal_strength: number
          signal_type: string
          status: string
          symbol: string
          x402_payment_tx: string | null
        }
        Insert: {
          agent_id?: string
          created_at?: string | null
          id?: string
          kraken_price?: number | null
          prism_risk_score?: number | null
          recall_cid?: string | null
          signal_strength: number
          signal_type: string
          status?: string
          symbol: string
          x402_payment_tx?: string | null
        }
        Update: {
          agent_id?: string
          created_at?: string | null
          id?: string
          kraken_price?: number | null
          prism_risk_score?: number | null
          recall_cid?: string | null
          signal_strength?: number
          signal_type?: string
          status?: string
          symbol?: string
          x402_payment_tx?: string | null
        }
        Relationships: []
      }
      trusttrader_agent_cards: {
        Row: {
          active: boolean
          agent_id: string
          created_at: string | null
          description: string
          display_name: string
          erc8004_agent_id: number | null
          erc8004_identity_id: string | null
          id: string
          image_url: string
          mcp_endpoint: string | null
          rep_id_external: number
          rep_id_internal: number
          skills: Json | null
          web_endpoint: string
          x402_support: boolean
        }
        Insert: {
          active?: boolean
          agent_id: string
          created_at?: string | null
          description: string
          display_name: string
          erc8004_agent_id?: number | null
          erc8004_identity_id?: string | null
          id?: string
          image_url?: string
          mcp_endpoint?: string | null
          rep_id_external?: number
          rep_id_internal?: number
          skills?: Json | null
          web_endpoint?: string
          x402_support?: boolean
        }
        Update: {
          active?: boolean
          agent_id?: string
          created_at?: string | null
          description?: string
          display_name?: string
          erc8004_agent_id?: number | null
          erc8004_identity_id?: string | null
          id?: string
          image_url?: string
          mcp_endpoint?: string | null
          rep_id_external?: number
          rep_id_internal?: number
          skills?: Json | null
          web_endpoint?: string
          x402_support?: boolean
        }
        Relationships: []
      }
      trusttrader_pending_credentials: {
        Row: {
          created_at: string | null
          credential_type: string
          id: string
          notes: string | null
          status: string
          stub_value: string | null
        }
        Insert: {
          created_at?: string | null
          credential_type: string
          id?: string
          notes?: string | null
          status?: string
          stub_value?: string | null
        }
        Update: {
          created_at?: string | null
          credential_type?: string
          id?: string
          notes?: string | null
          status?: string
          stub_value?: string | null
        }
        Relationships: []
      }
      trusttrader_sessions: {
        Row: {
          created_at: string | null
          current_balance_usd: number
          donation_total_usd: number
          erc8004_validation_count: number
          id: string
          kraken_paper_balance_usd: number
          max_drawdown_pct: number
          session_end: string | null
          session_start: string | null
          sharpe_ratio: number | null
          status: string
          total_pnl_usd: number
          total_trades: number
          total_vetoes: number
          user_id: string
        }
        Insert: {
          created_at?: string | null
          current_balance_usd?: number
          donation_total_usd?: number
          erc8004_validation_count?: number
          id?: string
          kraken_paper_balance_usd?: number
          max_drawdown_pct?: number
          session_end?: string | null
          session_start?: string | null
          sharpe_ratio?: number | null
          status?: string
          total_pnl_usd?: number
          total_trades?: number
          total_vetoes?: number
          user_id: string
        }
        Update: {
          created_at?: string | null
          current_balance_usd?: number
          donation_total_usd?: number
          erc8004_validation_count?: number
          id?: string
          kraken_paper_balance_usd?: number
          max_drawdown_pct?: number
          session_end?: string | null
          session_start?: string | null
          sharpe_ratio?: number | null
          status?: string
          total_pnl_usd?: number
          total_trades?: number
          total_vetoes?: number
          user_id?: string
        }
        Relationships: []
      }
      trusttrader_share_cards: {
        Row: {
          auto_tagged: boolean
          basescan_url: string | null
          card_type: string
          confidence_pct: number | null
          created_at: string | null
          donation_usd: number | null
          headline: string
          id: string
          pnl_usd: number | null
          proof_hash: string | null
          rep_id_after: number | null
          rep_id_before: number | null
          share_count: number
          signals_aligned: string[] | null
          subtext: string | null
          user_id: string
          x_post_url: string | null
        }
        Insert: {
          auto_tagged?: boolean
          basescan_url?: string | null
          card_type: string
          confidence_pct?: number | null
          created_at?: string | null
          donation_usd?: number | null
          headline: string
          id?: string
          pnl_usd?: number | null
          proof_hash?: string | null
          rep_id_after?: number | null
          rep_id_before?: number | null
          share_count?: number
          signals_aligned?: string[] | null
          subtext?: string | null
          user_id: string
          x_post_url?: string | null
        }
        Update: {
          auto_tagged?: boolean
          basescan_url?: string | null
          card_type?: string
          confidence_pct?: number | null
          created_at?: string | null
          donation_usd?: number | null
          headline?: string
          id?: string
          pnl_usd?: number | null
          proof_hash?: string | null
          rep_id_after?: number | null
          rep_id_before?: number | null
          share_count?: number
          signals_aligned?: string[] | null
          subtext?: string | null
          user_id?: string
          x_post_url?: string | null
        }
        Relationships: []
      }
      trusttrader_signal_licenses: {
        Row: {
          active: boolean
          created_at: string | null
          id: string
          license_type: string
          licensor_agent_id: string
          licensor_rep_id_internal: number
          notes: string | null
          price_per_day_usd: number | null
          price_per_signal_usd: number | null
          signal_accuracy_30d: number | null
          total_subscribers: number
          zkp_contact_hash: string | null
        }
        Insert: {
          active?: boolean
          created_at?: string | null
          id?: string
          license_type?: string
          licensor_agent_id: string
          licensor_rep_id_internal: number
          notes?: string | null
          price_per_day_usd?: number | null
          price_per_signal_usd?: number | null
          signal_accuracy_30d?: number | null
          total_subscribers?: number
          zkp_contact_hash?: string | null
        }
        Update: {
          active?: boolean
          created_at?: string | null
          id?: string
          license_type?: string
          licensor_agent_id?: string
          licensor_rep_id_internal?: number
          notes?: string | null
          price_per_day_usd?: number | null
          price_per_signal_usd?: number | null
          signal_accuracy_30d?: number | null
          total_subscribers?: number
          zkp_contact_hash?: string | null
        }
        Relationships: []
      }
      trusttrader_signals: {
        Row: {
          fetched_at: string | null
          id: number
          normalized: number
          signal_name: string
          source: string | null
          value: number
          weight: number
        }
        Insert: {
          fetched_at?: string | null
          id?: number
          normalized: number
          signal_name: string
          source?: string | null
          value: number
          weight?: number
        }
        Update: {
          fetched_at?: string | null
          id?: number
          normalized?: number
          signal_name?: string
          source?: string | null
          value?: number
          weight?: number
        }
        Relationships: []
      }
      usage_analytics: {
        Row: {
          action_type: string
          details: Json | null
          id: string
          timestamp: string
          user_id: string
        }
        Insert: {
          action_type: string
          details?: Json | null
          id?: string
          timestamp?: string
          user_id: string
        }
        Update: {
          action_type?: string
          details?: Json | null
          id?: string
          timestamp?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "usage_analytics_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["user_id"]
          },
        ]
      }
      user_agents: {
        Row: {
          agent_name: string
          agent_slug: string | null
          cloned_at: string | null
          created_at: string | null
          custodian_agent: string | null
          email_hash: string | null
          erc8004_token_id: string | null
          id: number
          is_cloned_to_real: boolean | null
          name_confirmed: boolean | null
          name_suggested_at: string | null
          paper_portfolio: Json | null
          repid_max: number | null
          repid_score: number | null
          repid_tier: string | null
          risk_tolerance: string | null
          signal_weight_overrides: Json | null
          total_agreed_with_sophia: number | null
          total_decisions: number | null
          total_disagreed_with_sophia: number | null
          updated_at: string | null
          user_id: string | null
          user_sided_with_agent_and_won: number | null
          user_sided_with_sophia_and_won: number | null
        }
        Insert: {
          agent_name: string
          agent_slug?: string | null
          cloned_at?: string | null
          created_at?: string | null
          custodian_agent?: string | null
          email_hash?: string | null
          erc8004_token_id?: string | null
          id?: number
          is_cloned_to_real?: boolean | null
          name_confirmed?: boolean | null
          name_suggested_at?: string | null
          paper_portfolio?: Json | null
          repid_max?: number | null
          repid_score?: number | null
          repid_tier?: string | null
          risk_tolerance?: string | null
          signal_weight_overrides?: Json | null
          total_agreed_with_sophia?: number | null
          total_decisions?: number | null
          total_disagreed_with_sophia?: number | null
          updated_at?: string | null
          user_id?: string | null
          user_sided_with_agent_and_won?: number | null
          user_sided_with_sophia_and_won?: number | null
        }
        Update: {
          agent_name?: string
          agent_slug?: string | null
          cloned_at?: string | null
          created_at?: string | null
          custodian_agent?: string | null
          email_hash?: string | null
          erc8004_token_id?: string | null
          id?: number
          is_cloned_to_real?: boolean | null
          name_confirmed?: boolean | null
          name_suggested_at?: string | null
          paper_portfolio?: Json | null
          repid_max?: number | null
          repid_score?: number | null
          repid_tier?: string | null
          risk_tolerance?: string | null
          signal_weight_overrides?: Json | null
          total_agreed_with_sophia?: number | null
          total_decisions?: number | null
          total_disagreed_with_sophia?: number | null
          updated_at?: string | null
          user_id?: string | null
          user_sided_with_agent_and_won?: number | null
          user_sided_with_sophia_and_won?: number | null
        }
        Relationships: []
      }
      user_api_keys: {
        Row: {
          created_at: string
          encrypted_api_key: string
          id: string
          key_hash: string | null
          key_prefix: string | null
          key_status: string | null
          last_used_at: string | null
          provider_name: string
          updated_at: string
          usage_count: number | null
          user_id: string
        }
        Insert: {
          created_at?: string
          encrypted_api_key: string
          id?: string
          key_hash?: string | null
          key_prefix?: string | null
          key_status?: string | null
          last_used_at?: string | null
          provider_name: string
          updated_at?: string
          usage_count?: number | null
          user_id: string
        }
        Update: {
          created_at?: string
          encrypted_api_key?: string
          id?: string
          key_hash?: string | null
          key_prefix?: string | null
          key_status?: string | null
          last_used_at?: string | null
          provider_name?: string
          updated_at?: string
          usage_count?: number | null
          user_id?: string
        }
        Relationships: []
      }
      user_badges: {
        Row: {
          badge_name: string
          badge_type: string
          description: string | null
          earned_at: string | null
          id: number
          user_id: number | null
        }
        Insert: {
          badge_name: string
          badge_type: string
          description?: string | null
          earned_at?: string | null
          id?: number
          user_id?: number | null
        }
        Update: {
          badge_name?: string
          badge_type?: string
          description?: string | null
          earned_at?: string | null
          id?: number
          user_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "user_badges_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "aidebate_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_badges_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_leaderboard"
            referencedColumns: ["id"]
          },
        ]
      }
      user_credits: {
        Row: {
          created_at: string
          id: string
          total_credits: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          total_credits?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          total_credits?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_journeys: {
        Row: {
          created_at: string | null
          highlights: string[] | null
          id: string
          last_explored: string | null
          path: Json | null
          return_prompt: string | null
          session_id: string | null
          suggested_next: string | null
          updated_at: string | null
          verified_user_id: string | null
          viewer_id: string | null
        }
        Insert: {
          created_at?: string | null
          highlights?: string[] | null
          id?: string
          last_explored?: string | null
          path?: Json | null
          return_prompt?: string | null
          session_id?: string | null
          suggested_next?: string | null
          updated_at?: string | null
          verified_user_id?: string | null
          viewer_id?: string | null
        }
        Update: {
          created_at?: string | null
          highlights?: string[] | null
          id?: string
          last_explored?: string | null
          path?: Json | null
          return_prompt?: string | null
          session_id?: string | null
          suggested_next?: string | null
          updated_at?: string | null
          verified_user_id?: string | null
          viewer_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "user_journeys_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "demo_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_journeys_verified_user_id_fkey"
            columns: ["verified_user_id"]
            isOneToOne: false
            referencedRelation: "verified_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_journeys_viewer_id_fkey"
            columns: ["viewer_id"]
            isOneToOne: false
            referencedRelation: "demo_viewers"
            referencedColumns: ["id"]
          },
        ]
      }
      user_keys: {
        Row: {
          chatgpt_key_enc: string | null
          claude_key_enc: string | null
          grok_key_enc: string | null
          id: string
          trinity_api_key: string | null
          user_id: string | null
        }
        Insert: {
          chatgpt_key_enc?: string | null
          claude_key_enc?: string | null
          grok_key_enc?: string | null
          id?: string
          trinity_api_key?: string | null
          user_id?: string | null
        }
        Update: {
          chatgpt_key_enc?: string | null
          claude_key_enc?: string | null
          grok_key_enc?: string | null
          id?: string
          trinity_api_key?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      user_memory: {
        Row: {
          content: string
          created_at: string
          id: string
          memory_type: string
          tags: string[] | null
          title: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          memory_type: string
          tags?: string[] | null
          title?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          memory_type?: string
          tags?: string[] | null
          title?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_memory_tier: {
        Row: {
          cold_access: boolean | null
          created_at: string | null
          glacier_access: boolean | null
          tier: string | null
          user_id: string
          warm_limit: number | null
        }
        Insert: {
          cold_access?: boolean | null
          created_at?: string | null
          glacier_access?: boolean | null
          tier?: string | null
          user_id: string
          warm_limit?: number | null
        }
        Update: {
          cold_access?: boolean | null
          created_at?: string | null
          glacier_access?: boolean | null
          tier?: string | null
          user_id?: string
          warm_limit?: number | null
        }
        Relationships: []
      }
      user_profiles: {
        Row: {
          created_at: string
          email: string
          full_name: string | null
          id: string
          subscription_expires_at: string | null
          subscription_status: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          email: string
          full_name?: string | null
          id?: string
          subscription_expires_at?: string | null
          subscription_status?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          email?: string
          full_name?: string | null
          id?: string
          subscription_expires_at?: string | null
          subscription_status?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_questions: {
        Row: {
          coherence_passed: boolean | null
          composite_score: number | null
          created_at: string | null
          diversity_score: number | null
          engagement_score: number | null
          id: number
          models_requested: string[] | null
          novelty_score: number | null
          promoted_to_topic_id: number | null
          question_text: string
          repid_staked: number | null
          resolution_score: number | null
          status: string | null
          user_id: number | null
        }
        Insert: {
          coherence_passed?: boolean | null
          composite_score?: number | null
          created_at?: string | null
          diversity_score?: number | null
          engagement_score?: number | null
          id?: number
          models_requested?: string[] | null
          novelty_score?: number | null
          promoted_to_topic_id?: number | null
          question_text: string
          repid_staked?: number | null
          resolution_score?: number | null
          status?: string | null
          user_id?: number | null
        }
        Update: {
          coherence_passed?: boolean | null
          composite_score?: number | null
          created_at?: string | null
          diversity_score?: number | null
          engagement_score?: number | null
          id?: number
          models_requested?: string[] | null
          novelty_score?: number | null
          promoted_to_topic_id?: number | null
          question_text?: string
          repid_staked?: number | null
          resolution_score?: number | null
          status?: string | null
          user_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "user_questions_promoted_to_topic_id_fkey"
            columns: ["promoted_to_topic_id"]
            isOneToOne: false
            referencedRelation: "aidebate_topics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_questions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "aidebate_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_questions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_leaderboard"
            referencedColumns: ["id"]
          },
        ]
      }
      user_sessions: {
        Row: {
          created_at: string
          id: string
          last_activity: string
          musing_count: number
          session_data: Json | null
          session_start: string
          total_duration: number
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          last_activity?: string
          musing_count?: number
          session_data?: Json | null
          session_start?: string
          total_duration?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          last_activity?: string
          musing_count?: number
          session_data?: Json | null
          session_start?: string
          total_duration?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_signal_configs: {
        Row: {
          created_at: string | null
          custom_source_url: string | null
          enabled: boolean | null
          id: number
          is_custom: boolean | null
          signal_key: string
          updated_at: string | null
          user_nickname: string
          weight: number | null
        }
        Insert: {
          created_at?: string | null
          custom_source_url?: string | null
          enabled?: boolean | null
          id?: number
          is_custom?: boolean | null
          signal_key: string
          updated_at?: string | null
          user_nickname: string
          weight?: number | null
        }
        Update: {
          created_at?: string | null
          custom_source_url?: string | null
          enabled?: boolean | null
          id?: number
          is_custom?: boolean | null
          signal_key?: string
          updated_at?: string | null
          user_nickname?: string
          weight?: number | null
        }
        Relationships: []
      }
      user_stories: {
        Row: {
          created_at: string | null
          demo_feasibility: string | null
          erc8004_touchpoints: string[] | null
          id: number
          job_to_be_done: string
          journey: string
          judge_criteria: string[] | null
          notes: string | null
          pain_points: string[] | null
          persona_name: string
          persona_type: string
          pitch_priority: number | null
          stewardship_moment: string
          story_id: string
          tagline: string
          wow_moment: string
        }
        Insert: {
          created_at?: string | null
          demo_feasibility?: string | null
          erc8004_touchpoints?: string[] | null
          id?: never
          job_to_be_done: string
          journey: string
          judge_criteria?: string[] | null
          notes?: string | null
          pain_points?: string[] | null
          persona_name: string
          persona_type: string
          pitch_priority?: number | null
          stewardship_moment: string
          story_id: string
          tagline: string
          wow_moment: string
        }
        Update: {
          created_at?: string | null
          demo_feasibility?: string | null
          erc8004_touchpoints?: string[] | null
          id?: never
          job_to_be_done?: string
          journey?: string
          judge_criteria?: string[] | null
          notes?: string | null
          pain_points?: string[] | null
          persona_name?: string
          persona_type?: string
          pitch_priority?: number | null
          stewardship_moment?: string
          story_id?: string
          tagline?: string
          wow_moment?: string
        }
        Relationships: []
      }
      user_streaks: {
        Row: {
          best_count: number | null
          current_count: number | null
          id: number
          last_activity: string | null
          streak_type: string
          user_id: number | null
        }
        Insert: {
          best_count?: number | null
          current_count?: number | null
          id?: number
          last_activity?: string | null
          streak_type: string
          user_id?: number | null
        }
        Update: {
          best_count?: number | null
          current_count?: number | null
          id?: number
          last_activity?: string | null
          streak_type?: string
          user_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "user_streaks_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "aidebate_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_streaks_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_leaderboard"
            referencedColumns: ["id"]
          },
        ]
      }
      user_voting_accuracy: {
        Row: {
          accuracy_delta: number | null
          consensus_vote: string | null
          debate_id: number | null
          id: number
          matched_consensus: boolean | null
          recorded_at: string | null
          user_id: number | null
          user_vote: string
        }
        Insert: {
          accuracy_delta?: number | null
          consensus_vote?: string | null
          debate_id?: number | null
          id?: number
          matched_consensus?: boolean | null
          recorded_at?: string | null
          user_id?: number | null
          user_vote: string
        }
        Update: {
          accuracy_delta?: number | null
          consensus_vote?: string | null
          debate_id?: number | null
          id?: number
          matched_consensus?: boolean | null
          recorded_at?: string | null
          user_id?: number | null
          user_vote?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_voting_accuracy_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "aidebate_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_voting_accuracy_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_leaderboard"
            referencedColumns: ["id"]
          },
        ]
      }
      validation_artifacts: {
        Row: {
          artifact_type: string | null
          created_at: string | null
          decision_id: number | null
          erc8004_registry: string | null
          id: number
          tx_hash: string | null
          zkp_proof_stub: Json | null
        }
        Insert: {
          artifact_type?: string | null
          created_at?: string | null
          decision_id?: number | null
          erc8004_registry?: string | null
          id?: never
          tx_hash?: string | null
          zkp_proof_stub?: Json | null
        }
        Update: {
          artifact_type?: string | null
          created_at?: string | null
          decision_id?: number | null
          erc8004_registry?: string | null
          id?: never
          tx_hash?: string | null
          zkp_proof_stub?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "validation_artifacts_decision_id_fkey"
            columns: ["decision_id"]
            isOneToOne: false
            referencedRelation: "trade_execution_log"
            referencedColumns: ["id"]
          },
        ]
      }
      validation_queue: {
        Row: {
          created_at: string | null
          deep_validation_needed: boolean
          fast_path_passed: boolean
          id: string
          judge_confidence: number | null
          judge_verdict: string | null
          metadata: Json | null
          pcp_score: number | null
          processed_at: string | null
          status: string
          substance_gate_event_id: string | null
          task_id: number
          validator_agents: string[] | null
          worker_verdict: string | null
        }
        Insert: {
          created_at?: string | null
          deep_validation_needed?: boolean
          fast_path_passed: boolean
          id?: string
          judge_confidence?: number | null
          judge_verdict?: string | null
          metadata?: Json | null
          pcp_score?: number | null
          processed_at?: string | null
          status?: string
          substance_gate_event_id?: string | null
          task_id: number
          validator_agents?: string[] | null
          worker_verdict?: string | null
        }
        Update: {
          created_at?: string | null
          deep_validation_needed?: boolean
          fast_path_passed?: boolean
          id?: string
          judge_confidence?: number | null
          judge_verdict?: string | null
          metadata?: Json | null
          pcp_score?: number | null
          processed_at?: string | null
          status?: string
          substance_gate_event_id?: string | null
          task_id?: number
          validator_agents?: string[] | null
          worker_verdict?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "validation_queue_substance_gate_event_id_fkey"
            columns: ["substance_gate_event_id"]
            isOneToOne: false
            referencedRelation: "substance_gate_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "validation_queue_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "trinity_post_task_lag"
            referencedColumns: ["task_id"]
          },
          {
            foreignKeyName: "validation_queue_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "trinity_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      value_assessments: {
        Row: {
          created_at: string
          id: string
          rating: number
          updated_at: string
          user_id: string
          value_category: string
          value_name: string
        }
        Insert: {
          created_at?: string
          id?: string
          rating: number
          updated_at?: string
          user_id: string
          value_category: string
          value_name: string
        }
        Update: {
          created_at?: string
          id?: string
          rating?: number
          updated_at?: string
          user_id?: string
          value_category?: string
          value_name?: string
        }
        Relationships: []
      }
      vault_access_log: {
        Row: {
          accessed_at: string | null
          action: string | null
          agent_name: string
          amount_usdc: number | null
          bft_consensus_proof: Json | null
          denied_reason: string | null
          id: number
          repid_at_access: number | null
          vault_id: string | null
        }
        Insert: {
          accessed_at?: string | null
          action?: string | null
          agent_name: string
          amount_usdc?: number | null
          bft_consensus_proof?: Json | null
          denied_reason?: string | null
          id?: number
          repid_at_access?: number | null
          vault_id?: string | null
        }
        Update: {
          accessed_at?: string | null
          action?: string | null
          agent_name?: string
          amount_usdc?: number | null
          bft_consensus_proof?: Json | null
          denied_reason?: string | null
          id?: number
          repid_at_access?: number | null
          vault_id?: string | null
        }
        Relationships: []
      }
      velocity_metrics: {
        Row: {
          agent_hours_saved: number | null
          automation_hours_saved: number | null
          avg_autonomy_score: number | null
          avg_veritas_score: number | null
          blockers_encountered: string[] | null
          bugs_fixed: number | null
          content_published: number | null
          features_shipped: number | null
          highlights: string[] | null
          human_overrides: number | null
          id: number
          improvements_made: string[] | null
          tasks_autonomous: number | null
          tasks_completed: number | null
          tasks_human_assisted: number | null
          total_hours_saved: number | null
          week_end: string
          week_start: string
        }
        Insert: {
          agent_hours_saved?: number | null
          automation_hours_saved?: number | null
          avg_autonomy_score?: number | null
          avg_veritas_score?: number | null
          blockers_encountered?: string[] | null
          bugs_fixed?: number | null
          content_published?: number | null
          features_shipped?: number | null
          highlights?: string[] | null
          human_overrides?: number | null
          id?: number
          improvements_made?: string[] | null
          tasks_autonomous?: number | null
          tasks_completed?: number | null
          tasks_human_assisted?: number | null
          total_hours_saved?: number | null
          week_end: string
          week_start: string
        }
        Update: {
          agent_hours_saved?: number | null
          automation_hours_saved?: number | null
          avg_autonomy_score?: number | null
          avg_veritas_score?: number | null
          blockers_encountered?: string[] | null
          bugs_fixed?: number | null
          content_published?: number | null
          features_shipped?: number | null
          highlights?: string[] | null
          human_overrides?: number | null
          id?: number
          improvements_made?: string[] | null
          tasks_autonomous?: number | null
          tasks_completed?: number | null
          tasks_human_assisted?: number | null
          total_hours_saved?: number | null
          week_end?: string
          week_start?: string
        }
        Relationships: []
      }
      verification_audits: {
        Row: {
          created_at: string | null
          failure_reason: string | null
          id: string
          ip_hash: string | null
          lead_id: string | null
          method: string
          success: boolean
          user_agent: string | null
          verified_user_id: string | null
        }
        Insert: {
          created_at?: string | null
          failure_reason?: string | null
          id?: string
          ip_hash?: string | null
          lead_id?: string | null
          method: string
          success: boolean
          user_agent?: string | null
          verified_user_id?: string | null
        }
        Update: {
          created_at?: string | null
          failure_reason?: string | null
          id?: string
          ip_hash?: string | null
          lead_id?: string | null
          method?: string
          success?: boolean
          user_agent?: string | null
          verified_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "verification_audits_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "verification_audits_verified_user_id_fkey"
            columns: ["verified_user_id"]
            isOneToOne: false
            referencedRelation: "verified_users"
            referencedColumns: ["id"]
          },
        ]
      }
      verification_votes: {
        Row: {
          confidence: number | null
          id: number
          reasoning: string | null
          task_id: number | null
          vote: string | null
          voted_at: string | null
          voter_agent: string
        }
        Insert: {
          confidence?: number | null
          id?: number
          reasoning?: string | null
          task_id?: number | null
          vote?: string | null
          voted_at?: string | null
          voter_agent: string
        }
        Update: {
          confidence?: number | null
          id?: number
          reasoning?: string | null
          task_id?: number | null
          vote?: string | null
          voted_at?: string | null
          voter_agent?: string
        }
        Relationships: [
          {
            foreignKeyName: "verification_votes_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "trinity_post_task_lag"
            referencedColumns: ["task_id"]
          },
          {
            foreignKeyName: "verification_votes_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "trinity_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      verified_users: {
        Row: {
          category: string | null
          created_at: string | null
          email: string | null
          engagement_score: number | null
          first_visit_at: string | null
          id: string
          invite_id: string | null
          last_visit_at: string | null
          lead_id: string | null
          linkedin_id: string | null
          phone: string | null
          repid_score: number | null
          signal_unlocked: boolean | null
          total_visits: number | null
          verification_method: string | null
        }
        Insert: {
          category?: string | null
          created_at?: string | null
          email?: string | null
          engagement_score?: number | null
          first_visit_at?: string | null
          id?: string
          invite_id?: string | null
          last_visit_at?: string | null
          lead_id?: string | null
          linkedin_id?: string | null
          phone?: string | null
          repid_score?: number | null
          signal_unlocked?: boolean | null
          total_visits?: number | null
          verification_method?: string | null
        }
        Update: {
          category?: string | null
          created_at?: string | null
          email?: string | null
          engagement_score?: number | null
          first_visit_at?: string | null
          id?: string
          invite_id?: string | null
          last_visit_at?: string | null
          lead_id?: string | null
          linkedin_id?: string | null
          phone?: string | null
          repid_score?: number | null
          signal_unlocked?: boolean | null
          total_visits?: number | null
          verification_method?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "verified_users_invite_id_fkey"
            columns: ["invite_id"]
            isOneToOne: false
            referencedRelation: "invites"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "verified_users_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      virtue_narratives: {
        Row: {
          blood_flow_status: string | null
          constitutional_hash: string | null
          created_at: string | null
          decision_id: string
          has_praise: boolean | null
          has_virtue: boolean | null
          id: string
          is_honest: boolean | null
          is_just: boolean | null
          is_lovely: boolean | null
          is_of_good_report: boolean | null
          is_pure: boolean | null
          is_true: boolean | null
          love_weight: number | null
          plain_english: string
          word_genesis_hash: string | null
        }
        Insert: {
          blood_flow_status?: string | null
          constitutional_hash?: string | null
          created_at?: string | null
          decision_id: string
          has_praise?: boolean | null
          has_virtue?: boolean | null
          id?: string
          is_honest?: boolean | null
          is_just?: boolean | null
          is_lovely?: boolean | null
          is_of_good_report?: boolean | null
          is_pure?: boolean | null
          is_true?: boolean | null
          love_weight?: number | null
          plain_english: string
          word_genesis_hash?: string | null
        }
        Update: {
          blood_flow_status?: string | null
          constitutional_hash?: string | null
          created_at?: string | null
          decision_id?: string
          has_praise?: boolean | null
          has_virtue?: boolean | null
          id?: string
          is_honest?: boolean | null
          is_just?: boolean | null
          is_lovely?: boolean | null
          is_of_good_report?: boolean | null
          is_pure?: boolean | null
          is_true?: boolean | null
          love_weight?: number | null
          plain_english?: string
          word_genesis_hash?: string | null
        }
        Relationships: []
      }
      voc_signals: {
        Row: {
          captured_at: string | null
          captured_by: string | null
          id: number
          opportunity: string | null
          pain_point: string | null
          raw_text: string | null
          related_idea_id: number | null
          sentiment_score: number | null
          source: string | null
          source_url: string | null
        }
        Insert: {
          captured_at?: string | null
          captured_by?: string | null
          id?: number
          opportunity?: string | null
          pain_point?: string | null
          raw_text?: string | null
          related_idea_id?: number | null
          sentiment_score?: number | null
          source?: string | null
          source_url?: string | null
        }
        Update: {
          captured_at?: string | null
          captured_by?: string | null
          id?: number
          opportunity?: string | null
          pain_point?: string | null
          raw_text?: string | null
          related_idea_id?: number | null
          sentiment_score?: number | null
          source?: string | null
          source_url?: string | null
        }
        Relationships: []
      }
      votes: {
        Row: {
          bonus_breakdown: Json | null
          created_at: string | null
          debate_id: number | null
          helpfulness_vote: string | null
          honesty_vote: string | null
          id: number
          repid_earned: number | null
          transparency_vote: string | null
          user_id: number | null
          vote_weight_applied: number | null
          voted_for: string
        }
        Insert: {
          bonus_breakdown?: Json | null
          created_at?: string | null
          debate_id?: number | null
          helpfulness_vote?: string | null
          honesty_vote?: string | null
          id?: number
          repid_earned?: number | null
          transparency_vote?: string | null
          user_id?: number | null
          vote_weight_applied?: number | null
          voted_for: string
        }
        Update: {
          bonus_breakdown?: Json | null
          created_at?: string | null
          debate_id?: number | null
          helpfulness_vote?: string | null
          honesty_vote?: string | null
          id?: number
          repid_earned?: number | null
          transparency_vote?: string | null
          user_id?: number | null
          vote_weight_applied?: number | null
          voted_for?: string
        }
        Relationships: [
          {
            foreignKeyName: "votes_debate_id_fkey"
            columns: ["debate_id"]
            isOneToOne: false
            referencedRelation: "active_debates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "votes_debate_id_fkey"
            columns: ["debate_id"]
            isOneToOne: false
            referencedRelation: "debates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "votes_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "aidebate_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "votes_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_leaderboard"
            referencedColumns: ["id"]
          },
        ]
      }
      vouch_relationships: {
        Row: {
          agent_address: string
          agent_rep_delta: number | null
          created_at: string | null
          id: string
          lock_duration_days: number | null
          lock_expires_at: string | null
          removed_at: string | null
          sponsor_address: string
          sponsor_rep_delta: number | null
          status: string | null
          tx_hash: string | null
          vouch_type: string
        }
        Insert: {
          agent_address: string
          agent_rep_delta?: number | null
          created_at?: string | null
          id?: string
          lock_duration_days?: number | null
          lock_expires_at?: string | null
          removed_at?: string | null
          sponsor_address: string
          sponsor_rep_delta?: number | null
          status?: string | null
          tx_hash?: string | null
          vouch_type: string
        }
        Update: {
          agent_address?: string
          agent_rep_delta?: number | null
          created_at?: string | null
          id?: string
          lock_duration_days?: number | null
          lock_expires_at?: string | null
          removed_at?: string | null
          sponsor_address?: string
          sponsor_rep_delta?: number | null
          status?: string | null
          tx_hash?: string | null
          vouch_type?: string
        }
        Relationships: []
      }
      waitlist: {
        Row: {
          consent_given_at: string | null
          consent_version: string | null
          created_at: string | null
          dbt_token_id: string | null
          disclosure_reason: string | null
          email: string
          email_hash: string | null
          github_username: string | null
          id: number
          kyc_provider: string | null
          kyc_token: string | null
          name: string | null
          nickname: string | null
          oauth_provider: string | null
          onboarding_stage: number | null
          pages_viewed: Json | null
          pain_points: Json | null
          points_earned: number | null
          privacy_tier: string | null
          referral_code: string | null
          referred_by: string | null
          source: string | null
          tutorials_completed: Json | null
          voluntary_disclosure: boolean | null
          what_building: string | null
        }
        Insert: {
          consent_given_at?: string | null
          consent_version?: string | null
          created_at?: string | null
          dbt_token_id?: string | null
          disclosure_reason?: string | null
          email: string
          email_hash?: string | null
          github_username?: string | null
          id?: number
          kyc_provider?: string | null
          kyc_token?: string | null
          name?: string | null
          nickname?: string | null
          oauth_provider?: string | null
          onboarding_stage?: number | null
          pages_viewed?: Json | null
          pain_points?: Json | null
          points_earned?: number | null
          privacy_tier?: string | null
          referral_code?: string | null
          referred_by?: string | null
          source?: string | null
          tutorials_completed?: Json | null
          voluntary_disclosure?: boolean | null
          what_building?: string | null
        }
        Update: {
          consent_given_at?: string | null
          consent_version?: string | null
          created_at?: string | null
          dbt_token_id?: string | null
          disclosure_reason?: string | null
          email?: string
          email_hash?: string | null
          github_username?: string | null
          id?: number
          kyc_provider?: string | null
          kyc_token?: string | null
          name?: string | null
          nickname?: string | null
          oauth_provider?: string | null
          onboarding_stage?: number | null
          pages_viewed?: Json | null
          pain_points?: Json | null
          points_earned?: number | null
          privacy_tier?: string | null
          referral_code?: string | null
          referred_by?: string | null
          source?: string | null
          tutorials_completed?: Json | null
          voluntary_disclosure?: boolean | null
          what_building?: string | null
        }
        Relationships: []
      }
      workflow_artifacts: {
        Row: {
          content_summary: string | null
          created_at: string | null
          created_by: string | null
          document_type: string
          github_path: string | null
          id: number
          last_updated_by: string | null
          phase: string
          pivot_history: Json | null
          primary_agent: string | null
          project_name: string
          status: string | null
          supporting_agents: string[] | null
          updated_at: string | null
          validated_at: string | null
          validation_metrics: Json | null
          version: number | null
        }
        Insert: {
          content_summary?: string | null
          created_at?: string | null
          created_by?: string | null
          document_type: string
          github_path?: string | null
          id?: number
          last_updated_by?: string | null
          phase: string
          pivot_history?: Json | null
          primary_agent?: string | null
          project_name: string
          status?: string | null
          supporting_agents?: string[] | null
          updated_at?: string | null
          validated_at?: string | null
          validation_metrics?: Json | null
          version?: number | null
        }
        Update: {
          content_summary?: string | null
          created_at?: string | null
          created_by?: string | null
          document_type?: string
          github_path?: string | null
          id?: number
          last_updated_by?: string | null
          phase?: string
          pivot_history?: Json | null
          primary_agent?: string | null
          project_name?: string
          status?: string | null
          supporting_agents?: string[] | null
          updated_at?: string | null
          validated_at?: string | null
          validation_metrics?: Json | null
          version?: number | null
        }
        Relationships: []
      }
      workspaces: {
        Row: {
          created_at: string | null
          id: string
          is_demo: boolean | null
          name: string
          owner_id: string | null
          slug: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          is_demo?: boolean | null
          name: string
          owner_id?: string | null
          slug?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          is_demo?: boolean | null
          name?: string
          owner_id?: string | null
          slug?: string | null
        }
        Relationships: []
      }
      x402_log: {
        Row: {
          action: string
          agent_id: string
          challenge_issued: Json | null
          created_at: string | null
          granted: boolean
          id: number
          repid_at_check: number | null
          status_code: number
        }
        Insert: {
          action: string
          agent_id: string
          challenge_issued?: Json | null
          created_at?: string | null
          granted?: boolean
          id?: never
          repid_at_check?: number | null
          status_code: number
        }
        Update: {
          action?: string
          agent_id?: string
          challenge_issued?: Json | null
          created_at?: string | null
          granted?: boolean
          id?: never
          repid_at_check?: number | null
          status_code?: number
        }
        Relationships: []
      }
      x402_recovery_worker_runs: {
        Row: {
          circuit_breaker_tripped: boolean
          completed_at: string | null
          created_at: string
          dry_run: boolean
          id: number
          notes: string | null
          rows_abandoned: number
          rows_eligible: number
          rows_examined: number
          rows_recovered: number
          rows_still_failing: number
          run_id: string
          started_at: string
        }
        Insert: {
          circuit_breaker_tripped?: boolean
          completed_at?: string | null
          created_at?: string
          dry_run?: boolean
          id?: number
          notes?: string | null
          rows_abandoned?: number
          rows_eligible?: number
          rows_examined?: number
          rows_recovered?: number
          rows_still_failing?: number
          run_id?: string
          started_at?: string
        }
        Update: {
          circuit_breaker_tripped?: boolean
          completed_at?: string | null
          created_at?: string
          dry_run?: boolean
          id?: number
          notes?: string | null
          rows_abandoned?: number
          rows_eligible?: number
          rows_examined?: number
          rows_recovered?: number
          rows_still_failing?: number
          run_id?: string
          started_at?: string
        }
        Relationships: []
      }
      x402_settlement_failures: {
        Row: {
          agent_id: string | null
          attempt_count: number
          created_at: string
          direction: string
          facilitator_response: Json | null
          id: number
          idempotency_key: string | null
          last_attempted_at: string
          payment_payload_b64: string
          payment_requirements: Json
          resolved_at: string | null
        }
        Insert: {
          agent_id?: string | null
          attempt_count?: number
          created_at?: string
          direction: string
          facilitator_response?: Json | null
          id?: number
          idempotency_key?: string | null
          last_attempted_at?: string
          payment_payload_b64: string
          payment_requirements: Json
          resolved_at?: string | null
        }
        Update: {
          agent_id?: string | null
          attempt_count?: number
          created_at?: string
          direction?: string
          facilitator_response?: Json | null
          id?: number
          idempotency_key?: string | null
          last_attempted_at?: string
          payment_payload_b64?: string
          payment_requirements?: Json
          resolved_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "x402_settlement_failures_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      x402_settlements: {
        Row: {
          amount: number
          asset: string
          created_at: string
          delivered_at: string | null
          id: string
          idempotency_key: string | null
          is_simulated: boolean
          payer_address: string | null
          prediction_topic: string
          provider_agent_id: string | null
          requestor_agent_id: string | null
          settlement_attempt_count: number
          status: string
          tip_id: string
          tx_hash: string | null
          x_payment_header: string | null
        }
        Insert: {
          amount: number
          asset?: string
          created_at?: string
          delivered_at?: string | null
          id?: string
          idempotency_key?: string | null
          is_simulated?: boolean
          payer_address?: string | null
          prediction_topic: string
          provider_agent_id?: string | null
          requestor_agent_id?: string | null
          settlement_attempt_count?: number
          status?: string
          tip_id: string
          tx_hash?: string | null
          x_payment_header?: string | null
        }
        Update: {
          amount?: number
          asset?: string
          created_at?: string
          delivered_at?: string | null
          id?: string
          idempotency_key?: string | null
          is_simulated?: boolean
          payer_address?: string | null
          prediction_topic?: string
          provider_agent_id?: string | null
          requestor_agent_id?: string | null
          settlement_attempt_count?: number
          status?: string
          tip_id?: string
          tx_hash?: string | null
          x_payment_header?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "x402_settlements_provider_agent_id_fkey"
            columns: ["provider_agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "x402_settlements_requestor_agent_id_fkey"
            columns: ["requestor_agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      zkp_circuits: {
        Row: {
          approximate_gates: number
          chain: string | null
          circuit_name: string
          circuit_type: string
          created_at: string | null
          id: number
          inputs: Json
          on_chain_gas_estimate: number | null
          outputs: Json
          plain_english: string
          privacy_guarantee: string
          proof_gen_environment: string | null
          proof_gen_time_ms: number
          prover: string | null
          recursive: boolean | null
          registry: string | null
          verifies_circuits: string[] | null
        }
        Insert: {
          approximate_gates: number
          chain?: string | null
          circuit_name: string
          circuit_type: string
          created_at?: string | null
          id?: never
          inputs: Json
          on_chain_gas_estimate?: number | null
          outputs: Json
          plain_english: string
          privacy_guarantee: string
          proof_gen_environment?: string | null
          proof_gen_time_ms: number
          prover?: string | null
          recursive?: boolean | null
          registry?: string | null
          verifies_circuits?: string[] | null
        }
        Update: {
          approximate_gates?: number
          chain?: string | null
          circuit_name?: string
          circuit_type?: string
          created_at?: string | null
          id?: never
          inputs?: Json
          on_chain_gas_estimate?: number | null
          outputs?: Json
          plain_english?: string
          privacy_guarantee?: string
          proof_gen_environment?: string | null
          proof_gen_time_ms?: number
          prover?: string | null
          recursive?: boolean | null
          registry?: string | null
          verifies_circuits?: string[] | null
        }
        Relationships: []
      }
      zkp_repid_architecture: {
        Row: {
          build_phase: string
          category: string
          component: string
          constraints: string[] | null
          created_at: string | null
          description: string
          elasticity_notes: string | null
          id: number
          inputs: Json | null
          outputs: Json | null
          unlocks: string[] | null
        }
        Insert: {
          build_phase: string
          category: string
          component: string
          constraints?: string[] | null
          created_at?: string | null
          description: string
          elasticity_notes?: string | null
          id?: never
          inputs?: Json | null
          outputs?: Json | null
          unlocks?: string[] | null
        }
        Update: {
          build_phase?: string
          category?: string
          component?: string
          constraints?: string[] | null
          created_at?: string | null
          description?: string
          elasticity_notes?: string | null
          id?: never
          inputs?: Json | null
          outputs?: Json | null
          unlocks?: string[] | null
        }
        Relationships: []
      }
    }
    Views: {
      active_debates: {
        Row: {
          created_at: string | null
          id: number | null
          model_a: string | null
          model_a_votes: number | null
          model_b: string | null
          model_b_votes: number | null
          model_c: string | null
          model_c_votes: number | null
          status: string | null
          title: string | null
          total_views: number | null
          viral_hook: string | null
        }
        Relationships: []
      }
      agent_dashboard: {
        Row: {
          active_tasks: number | null
          agent_name: string | null
          avg_autonomy: number | null
          last_activity: string | null
          total_tasks: number | null
          weekly_hours_saved: number | null
        }
        Relationships: []
      }
      agent_health_dashboard: {
        Row: {
          id: string | null
          last_heartbeat: string | null
          minutes_since_heartbeat: number | null
          name: string | null
          repid_balance: number | null
          role: string | null
          stake_accuracy: number | null
          status: string | null
          tasks_completed: number | null
        }
        Insert: {
          id?: string | null
          last_heartbeat?: string | null
          minutes_since_heartbeat?: never
          name?: string | null
          repid_balance?: number | null
          role?: string | null
          stake_accuracy?: number | null
          status?: string | null
          tasks_completed?: number | null
        }
        Update: {
          id?: string | null
          last_heartbeat?: string | null
          minutes_since_heartbeat?: never
          name?: string | null
          repid_balance?: number | null
          role?: string | null
          stake_accuracy?: number | null
          status?: string | null
          tasks_completed?: number | null
        }
        Relationships: []
      }
      ai_leaderboard: {
        Row: {
          benchmark_source: string | null
          confidence: number | null
          name: string | null
          overall_repid: number | null
          provider: string | null
          rank: number | null
          score_capability: number | null
          score_ethics: number | null
          score_helpfulness: number | null
          score_honesty: number | null
          score_safety: number | null
          score_transparency: number | null
          total_votes: number | null
          win_rate: number | null
        }
        Relationships: []
      }
      ai_models_for_sync: {
        Row: {
          avatar_url: string | null
          creativity_score: number | null
          current_rank: number | null
          debates_won: number | null
          empathy_score: number | null
          honesty_score: number | null
          id: number | null
          logic_score: number | null
          model_version: string | null
          name: string | null
          overall_score: number | null
          provider: string | null
          total_debates: number | null
          total_votes_received: number | null
          updated_at: string | null
        }
        Relationships: []
      }
      cascade_pipeline_health: {
        Row: {
          count: number | null
          last_hour: number | null
          newest: string | null
          oldest: string | null
          oldest_age_min: number | null
          status: string | null
        }
        Relationships: []
      }
      cascade_telemetry_v1: {
        Row: {
          buyer_agent_id: string | null
          comma_gap: number | null
          comma_severity: string | null
          comma_veto: boolean | null
          contract_id: string | null
          created_at: string | null
          dispute_verdict: string | null
          disputed_at: string | null
          fulfilled_at: string | null
          judge_attempts: number | null
          judge_confidence: number | null
          judge_provider: string | null
          judge_verdict: string | null
          pcp_confidence: number | null
          pcp_score: number | null
          pcp_validators: Json | null
          provider_agent_id: string | null
          resolved_at: string | null
          status: string | null
          test_marker: string | null
          validator_count: number | null
          verdict: string | null
        }
        Insert: {
          buyer_agent_id?: string | null
          comma_gap?: never
          comma_severity?: never
          comma_veto?: never
          contract_id?: string | null
          created_at?: string | null
          dispute_verdict?: string | null
          disputed_at?: string | null
          fulfilled_at?: string | null
          judge_attempts?: never
          judge_confidence?: never
          judge_provider?: never
          judge_verdict?: never
          pcp_confidence?: never
          pcp_score?: never
          pcp_validators?: never
          provider_agent_id?: string | null
          resolved_at?: string | null
          status?: string | null
          test_marker?: never
          validator_count?: never
          verdict?: never
        }
        Update: {
          buyer_agent_id?: string | null
          comma_gap?: never
          comma_severity?: never
          comma_veto?: never
          contract_id?: string | null
          created_at?: string | null
          dispute_verdict?: string | null
          disputed_at?: string | null
          fulfilled_at?: string | null
          judge_attempts?: never
          judge_confidence?: never
          judge_provider?: never
          judge_verdict?: never
          pcp_confidence?: never
          pcp_score?: never
          pcp_validators?: never
          provider_agent_id?: string | null
          resolved_at?: string | null
          status?: string | null
          test_marker?: never
          validator_count?: never
          verdict?: never
        }
        Relationships: [
          {
            foreignKeyName: "service_contracts_buyer_agent_id_fkey"
            columns: ["buyer_agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_contracts_provider_agent_id_fkey"
            columns: ["provider_agent_id"]
            isOneToOne: false
            referencedRelation: "repid_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      hal_accuracy_summary: {
        Row: {
          computed_at: string | null
          data_quality: string | null
          f1_score: number | null
          false_positive_rate: number | null
          fn: number | null
          fp: number | null
          precision: number | null
          recall: number | null
          source_table: string | null
          tn: number | null
          total_labeled: number | null
          total_raw: number | null
          tp: number | null
        }
        Relationships: []
      }
      hal_accuracy_summary_by_domain: {
        Row: {
          computed_at: string | null
          f1_score: number | null
          false_positive_rate: number | null
          fn: number | null
          fp: number | null
          precision: number | null
          recall: number | null
          task_domain: string | null
          tn: number | null
          total_labeled: number | null
          tp: number | null
        }
        Relationships: []
      }
      healing_active_bugs: {
        Row: {
          bug_code: string | null
          fix_attempts: number | null
          id: string | null
          last_fix_attempt: string | null
          last_seen: string | null
          severity: string | null
          times_encountered: number | null
          title: string | null
        }
        Relationships: []
      }
      healing_open_requests: {
        Row: {
          bug_code: string | null
          bug_id: string | null
          bug_title: string | null
          claimed_at: string | null
          completed_at: string | null
          context: Json | null
          id: string | null
          request_type: string | null
          requested_at: string | null
          requesting_agent: string | null
          response: Json | null
          severity: string | null
          status: string | null
          target_agent: string | null
        }
        Relationships: [
          {
            foreignKeyName: "healing_requests_bug_id_fkey"
            columns: ["bug_id"]
            isOneToOne: false
            referencedRelation: "healing_active_bugs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "healing_requests_bug_id_fkey"
            columns: ["bug_id"]
            isOneToOne: false
            referencedRelation: "healing_bugs"
            referencedColumns: ["id"]
          },
        ]
      }
      health_status: {
        Row: {
          agent: string | null
          checked_at: string | null
          details: Json | null
          errors_detected: number | null
          healing_triggered: boolean | null
          status: string | null
        }
        Relationships: []
      }
      llm_trust_leaderboard: {
        Row: {
          agents_using: number | null
          avg_certainty: number | null
          hallucination_rate_pct: number | null
          hallucinations_caught: number | null
          last_decision: string | null
          llm_model: string | null
          llm_provider: string | null
          total_decisions: number | null
          trust_score_pct: number | null
        }
        Relationships: []
      }
      merged_sprint_status: {
        Row: {
          migration_name: string | null
          migration_version: string | null
          sprint_label: string | null
          sprint_migration_count: number | null
        }
        Relationships: []
      }
      provider_health_summary: {
        Row: {
          avg_success_latency_ms: number | null
          failures: number | null
          last_attempt_at: string | null
          last_failure_at: string | null
          last_failure_mode: string | null
          last_success_at: string | null
          provider: string | null
          skips: number | null
          success_rate: number | null
          successes: number | null
          total_attempts: number | null
        }
        Relationships: []
      }
      queue_health: {
        Row: {
          active_tasks: number | null
          completed_24h: number | null
          evergreen_templates: number | null
          pending_tasks: number | null
          queue_status: string | null
        }
        Relationships: []
      }
      repid_config_view: {
        Row: {
          change_method: string | null
          description: string | null
          key: string | null
          max_value: number | null
          min_value: number | null
          value: string | null
        }
        Insert: {
          change_method?: never
          description?: string | null
          key?: string | null
          max_value?: number | null
          min_value?: number | null
          value?: string | null
        }
        Update: {
          change_method?: never
          description?: string | null
          key?: string | null
          max_value?: number | null
          min_value?: number | null
          value?: string | null
        }
        Relationships: []
      }
      repid_leaderboard_public: {
        Row: {
          activity_30d: number | null
          adversarial_resilience_score: number | null
          agent_name: string | null
          agent_type: string | null
          current_repid: number | null
          domain_accuracy: Json | null
          is_human: boolean | null
          last_updated: string | null
          tier: string | null
          vdr_count: number | null
          wisdom_score: number | null
        }
        Relationships: []
      }
      repid_standings: {
        Row: {
          accuracy_pct: number | null
          agent_name: string | null
          challenges_today: number | null
          conductor_sessions: number | null
          free_left: number | null
          last_activity: string | null
          repid_score: number | null
          tier: string | null
          total_challenges_correct: number | null
          total_challenges_made: number | null
          total_times_challenged: number | null
          total_times_vindicated: number | null
        }
        Insert: {
          accuracy_pct?: never
          agent_name?: string | null
          challenges_today?: number | null
          conductor_sessions?: number | null
          free_left?: never
          last_activity?: string | null
          repid_score?: number | null
          tier?: string | null
          total_challenges_correct?: number | null
          total_challenges_made?: number | null
          total_times_challenged?: number | null
          total_times_vindicated?: number | null
        }
        Update: {
          accuracy_pct?: never
          agent_name?: string | null
          challenges_today?: number | null
          conductor_sessions?: number | null
          free_left?: never
          last_activity?: string | null
          repid_score?: number | null
          tier?: string | null
          total_challenges_correct?: number | null
          total_challenges_made?: number | null
          total_times_challenged?: number | null
          total_times_vindicated?: number | null
        }
        Relationships: []
      }
      sanity_hour_queue: {
        Row: {
          action_needed: string | null
          blocked_reason: string | null
          design_score: number | null
          id: number | null
          owned_by: string | null
          priority: number | null
          project_name: string | null
          stage: string | null
          status: string | null
        }
        Insert: {
          action_needed?: never
          blocked_reason?: string | null
          design_score?: number | null
          id?: number | null
          owned_by?: string | null
          priority?: number | null
          project_name?: string | null
          stage?: string | null
          status?: string | null
        }
        Update: {
          action_needed?: never
          blocked_reason?: string | null
          design_score?: number | null
          id?: number | null
          owned_by?: string | null
          priority?: number | null
          project_name?: string | null
          stage?: string | null
          status?: string | null
        }
        Relationships: []
      }
      social_mirror_daily_stats: {
        Row: {
          agents_used: number | null
          analyses: number | null
          avg_eq: number | null
          avg_iq: number | null
          avg_latency_ms: number | null
          avg_resonance: number | null
          avg_sq: number | null
          date: string | null
          feedback_count: number | null
        }
        Relationships: []
      }
      social_mirror_provider_stats: {
        Row: {
          avg_certainty: number | null
          avg_latency_ms: number | null
          calls: number | null
          provider: string | null
        }
        Relationships: []
      }
      social_mirror_type_distribution: {
        Row: {
          count: number | null
          mirror_type: string | null
          percentage: number | null
        }
        Relationships: []
      }
      sprint_queue_ready: {
        Row: {
          acceptance_criteria: string | null
          assigned_agent: string | null
          backlog_ref: string | null
          blocks: number[] | null
          claimed_at: string | null
          claimed_by: string | null
          completed_at: string | null
          created_at: string | null
          depends_on: number[] | null
          deploy_url: string | null
          description: string | null
          errors: string | null
          estimated_hours: number | null
          hackathon_ref: string | null
          id: number | null
          outcome: string | null
          patent_ref: string | null
          priority: number | null
          prompt_text: string | null
          repo: string | null
          repo_path: string | null
          source: string | null
          sprint_id: string | null
          sprint_type: string | null
          started_at: string | null
          status: string | null
          title: string | null
          updated_at: string | null
          verification_commands: string | null
        }
        Insert: {
          acceptance_criteria?: string | null
          assigned_agent?: string | null
          backlog_ref?: string | null
          blocks?: number[] | null
          claimed_at?: string | null
          claimed_by?: string | null
          completed_at?: string | null
          created_at?: string | null
          depends_on?: number[] | null
          deploy_url?: string | null
          description?: string | null
          errors?: string | null
          estimated_hours?: number | null
          hackathon_ref?: string | null
          id?: number | null
          outcome?: string | null
          patent_ref?: string | null
          priority?: number | null
          prompt_text?: string | null
          repo?: string | null
          repo_path?: string | null
          source?: string | null
          sprint_id?: string | null
          sprint_type?: string | null
          started_at?: string | null
          status?: string | null
          title?: string | null
          updated_at?: string | null
          verification_commands?: string | null
        }
        Update: {
          acceptance_criteria?: string | null
          assigned_agent?: string | null
          backlog_ref?: string | null
          blocks?: number[] | null
          claimed_at?: string | null
          claimed_by?: string | null
          completed_at?: string | null
          created_at?: string | null
          depends_on?: number[] | null
          deploy_url?: string | null
          description?: string | null
          errors?: string | null
          estimated_hours?: number | null
          hackathon_ref?: string | null
          id?: number | null
          outcome?: string | null
          patent_ref?: string | null
          priority?: number | null
          prompt_text?: string | null
          repo?: string | null
          repo_path?: string | null
          source?: string | null
          sprint_id?: string | null
          sprint_type?: string | null
          started_at?: string | null
          status?: string | null
          title?: string | null
          updated_at?: string | null
          verification_commands?: string | null
        }
        Relationships: []
      }
      sync_status_dashboard: {
        Row: {
          metric: string | null
          value: string | null
        }
        Relationships: []
      }
      trinity_agent_log_summary: {
        Row: {
          agent_name: string | null
          avg_duration_sec: number | null
          completed: number | null
          failed: number | null
          last_activity: string | null
          looping: number | null
          total_logs: number | null
          total_loops: number | null
          with_artifacts: number | null
        }
        Relationships: []
      }
      trinity_agent_performance: {
        Row: {
          agent: string | null
          avg_duration_sec: number | null
          completed: number | null
          date: string | null
          with_artifacts: number | null
        }
        Relationships: []
      }
      trinity_agent_summary: {
        Row: {
          agent: string | null
          health: string | null
          last_seen: string | null
          primary_virtue: string | null
          repid_score: number | null
          status: string | null
          tasks_completed: number | null
          version: string | null
        }
        Relationships: []
      }
      trinity_approval_queue: {
        Row: {
          action_type: string | null
          agent: string | null
          artifact_type: string | null
          created_at: string | null
          external_url: string | null
          filename: string | null
          hours_waiting: number | null
          id: number | null
          preview: string | null
          risk_level: string | null
          status: string | null
          title: string | null
        }
        Relationships: []
      }
      trinity_claim_rate_last_24h: {
        Row: {
          claims_in_hour: number | null
          completed_in_hour: number | null
          distinct_agents: number | null
          hour_utc: string | null
        }
        Relationships: []
      }
      trinity_daily_metrics: {
        Row: {
          archived: number | null
          artifact_rate_pct: number | null
          completed: number | null
          date: string | null
          tasks_created: number | null
          with_artifacts: number | null
        }
        Relationships: []
      }
      trinity_dormancy_events_recent: {
        Row: {
          gap_end_utc: string | null
          gap_minutes: number | null
          gap_severity: string | null
          gap_start_utc: string | null
        }
        Relationships: []
      }
      trinity_healing_summary: {
        Row: {
          events: number | null
          hour: string | null
          pending: number | null
          resolved: number | null
        }
        Relationships: []
      }
      trinity_infection_status: {
        Row: {
          agent: string | null
          health_color: string | null
          heartbeat_status: string | null
          infection_status: string | null
          last_seen: string | null
          minutes_since_heartbeat: number | null
          primary_virtue: string | null
          repid_score: number | null
          status: string | null
          version: string | null
        }
        Relationships: []
      }
      trinity_post_task_lag: {
        Row: {
          agent: string | null
          lag_class: string | null
          lag_minutes: number | null
          next_claim_at: string | null
          next_task_id: number | null
          task_id: number | null
          this_completed: string | null
        }
        Relationships: []
      }
      trinity_provider_stats: {
        Row: {
          agents_using: number | null
          avg_latency: number | null
          avg_success_rate: number | null
          provider: string | null
          total_calls: number | null
        }
        Relationships: []
      }
      trinity_quality_report: {
        Row: {
          count: number | null
          first_tagged: string | null
          last_tagged: string | null
          tag: string | null
          tag_category: string | null
        }
        Relationships: []
      }
      trinity_swarm_health: {
        Row: {
          agent_name: string | null
          computed_at: string | null
          expected_spokesperson: string | null
          expected_squad: string | null
          heartbeat_last_seen: string | null
          heartbeat_status: string | null
          heartbeat_version: string | null
          last_artifact_at: string | null
          last_task_claimed_at: string | null
          minutes_since_last_seen: number | null
          spokesperson_last_score_event_at: string | null
          spokesperson_uuid: string | null
          squad_role: string | null
          status_color: string | null
        }
        Relationships: []
      }
      trinity_swarm_summary: {
        Row: {
          claim_dormant: number | null
          healthy: number | null
          heartbeat_stale: number | null
          no_recent_claims: number | null
          runloop_not_iterating: number | null
          total_agents: number | null
          warning: number | null
        }
        Relationships: []
      }
      trinity_weekly_wisdom: {
        Row: {
          approved: number | null
          contributors: number | null
          pending: number | null
          total: number | null
          week: string | null
        }
        Relationships: []
      }
      trinity_worker_liveness_current: {
        Row: {
          agent_name: string | null
          claims_last_hour: number | null
          code_version: string | null
          completions_last_hour: number | null
          current_task_id: number | null
          heartbeat_status: string | null
          last_claim_at: string | null
          last_completed_at: string | null
          last_ping: string | null
          loop_count: number | null
          min_since_last_claim: number | null
          min_since_ping: number | null
          overall_health: string | null
          tasks_completed_session: number | null
          tasks_failed_session: number | null
        }
        Relationships: []
      }
      trustshell_ecosystem_stats: {
        Row: {
          agent_count: number | null
          display_name: string | null
          domain: string | null
          features: Json | null
          on_chain_contract: string | null
          on_chain_network: string | null
          protection_rate: number | null
          status: string | null
          total_decisions: number | null
          total_vetoes: number | null
          vertical: string | null
        }
        Relationships: []
      }
      user_leaderboard: {
        Row: {
          alter_ego_name: string | null
          display_name: string | null
          email: string | null
          id: number | null
          mission_heart: number | null
          rank: number | null
          repid_balance: number | null
          tier: string | null
          total_votes: number | null
          vote_accuracy: number | null
          vote_streak: number | null
        }
        Relationships: []
      }
      v_active_swarm_summary: {
        Row: {
          active_agents: number | null
          online_agents: number | null
        }
        Relationships: []
      }
      v_agent_cost_summary: {
        Row: {
          agent: string | null
          avg_certainty: number | null
          first_task: string | null
          free_tier_tasks: number | null
          latest_task: string | null
          paid_tier_tasks: number | null
          provider: string | null
          tasks_completed: number | null
        }
        Relationships: []
      }
      v_agent_health: {
        Row: {
          agent_name: string | null
          available_mcps: string[] | null
          completion_pct: number | null
          current_task_summary: string | null
          current_tier: string | null
          failed_tasks: number | null
          health_status: string | null
          last_active: string | null
          last_ping: string | null
          loop_count: number | null
          minutes_since_activity: number | null
          reputation_score: number | null
          squad: string | null
          status: string | null
          tasks_claimed: number | null
          tasks_completed: number | null
        }
        Relationships: []
      }
      v_agent_metrics: {
        Row: {
          agent: string | null
          avg_certainty: number | null
          avg_reasoning_depth: number | null
          last_completion: string | null
          real_completions: number | null
          reflection_count: number | null
          tasks_completed: number | null
        }
        Relationships: []
      }
      v_antifragility_score: {
        Row: {
          antifragility_score: number | null
          losses: number | null
          stress_events: number | null
          system_state: string | null
          week: string | null
          wins: number | null
        }
        Relationships: []
      }
      v_autonomous_queue: {
        Row: {
          assigned_to: string | null
          created: string | null
          created_by: string | null
          id: number | null
          priority: number | null
          requires_sean_approval: boolean | null
          status: string | null
          title: string | null
        }
        Insert: {
          assigned_to?: string | null
          created?: never
          created_by?: string | null
          id?: number | null
          priority?: number | null
          requires_sean_approval?: boolean | null
          status?: string | null
          title?: string | null
        }
        Update: {
          assigned_to?: string | null
          created?: never
          created_by?: string | null
          id?: number | null
          priority?: number | null
          requires_sean_approval?: boolean | null
          status?: string | null
          title?: string | null
        }
        Relationships: []
      }
      v_blueprint_progress: {
        Row: {
          codename: string | null
          lessons_count: number | null
          name: string | null
          sequence: number | null
          status: string | null
          status_icon: string | null
          verified_at: string | null
          verified_by: string | null
        }
        Insert: {
          codename?: string | null
          lessons_count?: never
          name?: string | null
          sequence?: number | null
          status?: string | null
          status_icon?: never
          verified_at?: string | null
          verified_by?: string | null
        }
        Update: {
          codename?: string | null
          lessons_count?: never
          name?: string | null
          sequence?: number | null
          status?: string | null
          status_icon?: never
          verified_at?: string | null
          verified_by?: string | null
        }
        Relationships: []
      }
      v_cascade_baseline_2026_05_18: {
        Row: {
          anchors_count: number | null
          claimer: string | null
          comma_severity: string | null
          composite_verdict: string | null
          contract_id: string | null
          escrow_to_fulfill_seconds: number | null
          judge_confidence: number | null
          judge_used: string | null
          pcp_score: number | null
          score_events_count: number | null
          test_marker: string | null
        }
        Insert: {
          anchors_count?: never
          claimer?: never
          comma_severity?: never
          composite_verdict?: never
          contract_id?: string | null
          escrow_to_fulfill_seconds?: never
          judge_confidence?: never
          judge_used?: never
          pcp_score?: never
          score_events_count?: never
          test_marker?: never
        }
        Update: {
          anchors_count?: never
          claimer?: never
          comma_severity?: never
          composite_verdict?: never
          contract_id?: string | null
          escrow_to_fulfill_seconds?: never
          judge_confidence?: never
          judge_used?: never
          pcp_score?: never
          score_events_count?: never
          test_marker?: never
        }
        Relationships: []
      }
      v_cc_inbox: {
        Row: {
          content_preview: string | null
          created_at: string | null
          from_ai: string | null
          id: number | null
          priority: number | null
          requires_response: boolean | null
          subject: string | null
        }
        Insert: {
          content_preview?: never
          created_at?: string | null
          from_ai?: string | null
          id?: number | null
          priority?: number | null
          requires_response?: boolean | null
          subject?: string | null
        }
        Update: {
          content_preview?: never
          created_at?: string | null
          from_ai?: string | null
          id?: number | null
          priority?: number | null
          requires_response?: boolean | null
          subject?: string | null
        }
        Relationships: []
      }
      v_claude: {
        Row: {
          claimed_by: string | null
          created_at: string | null
          description: string | null
          github_link: string | null
          handoff_notes: string | null
          id: string | null
          priority: number | null
          scenario: string | null
          status: string | null
          task_hash: string | null
          title: string | null
          version: number | null
        }
        Insert: {
          claimed_by?: string | null
          created_at?: string | null
          description?: string | null
          github_link?: string | null
          handoff_notes?: string | null
          id?: string | null
          priority?: number | null
          scenario?: string | null
          status?: string | null
          task_hash?: string | null
          title?: string | null
          version?: number | null
        }
        Update: {
          claimed_by?: string | null
          created_at?: string | null
          description?: string | null
          github_link?: string | null
          handoff_notes?: string | null
          id?: string | null
          priority?: number | null
          scenario?: string | null
          status?: string | null
          task_hash?: string | null
          title?: string | null
          version?: number | null
        }
        Relationships: []
      }
      v_claude_session_start: {
        Row: {
          category: string | null
          data: string | null
        }
        Relationships: []
      }
      v_contribution_score: {
        Row: {
          appreciation_multiplier: number | null
          contribution_ratio: number | null
          ecosystems_active_in: number | null
          email: string | null
          last_contribution: string | null
          nickname: string | null
          sweat_equity_points: number | null
          token_tier: string | null
          total_points: number | null
        }
        Relationships: []
      }
      v_dashboard: {
        Row: {
          claimed_by: string | null
          created_at: string | null
          description: string | null
          github_link: string | null
          handoff_notes: string | null
          id: string | null
          priority: number | null
          scenario: string | null
          status: string | null
          task_hash: string | null
          title: string | null
          version: number | null
        }
        Insert: {
          claimed_by?: string | null
          created_at?: string | null
          description?: string | null
          github_link?: string | null
          handoff_notes?: string | null
          id?: string | null
          priority?: number | null
          scenario?: string | null
          status?: string | null
          task_hash?: string | null
          title?: string | null
          version?: number | null
        }
        Update: {
          claimed_by?: string | null
          created_at?: string | null
          description?: string | null
          github_link?: string | null
          handoff_notes?: string | null
          id?: string | null
          priority?: number | null
          scenario?: string | null
          status?: string | null
          task_hash?: string | null
          title?: string | null
          version?: number | null
        }
        Relationships: []
      }
      v_deployment_compliance: {
        Row: {
          agent: string | null
          compliance_status: string | null
          expected_commit: string | null
          expected_version: string | null
          last_seen: string | null
          minutes_since_heartbeat: number | null
          running_version: string | null
        }
        Relationships: []
      }
      v_experiment_results: {
        Row: {
          avg_dissent_score: number | null
          avg_latency_ms: number | null
          baseline_rate: number | null
          bft_consensus_enabled: boolean | null
          catch_rate_pct: number | null
          catches: number | null
          config_name: string | null
          is_baseline: boolean | null
          pythagorean_comma_enabled: boolean | null
          sbfa_enabled: boolean | null
          sbt_enabled: boolean | null
          total_tests: number | null
        }
        Relationships: []
      }
      v_gemini_inbox: {
        Row: {
          content_preview: string | null
          created_at: string | null
          from_ai: string | null
          id: number | null
          priority: number | null
          requires_response: boolean | null
          subject: string | null
        }
        Insert: {
          content_preview?: never
          created_at?: string | null
          from_ai?: string | null
          id?: number | null
          priority?: number | null
          requires_response?: boolean | null
          subject?: string | null
        }
        Update: {
          content_preview?: never
          created_at?: string | null
          from_ai?: string | null
          id?: number | null
          priority?: number | null
          requires_response?: boolean | null
          subject?: string | null
        }
        Relationships: []
      }
      v_grok: {
        Row: {
          claimed_by: string | null
          created_at: string | null
          description: string | null
          github_link: string | null
          handoff_notes: string | null
          id: string | null
          priority: number | null
          scenario: string | null
          status: string | null
          task_hash: string | null
          title: string | null
          version: number | null
        }
        Insert: {
          claimed_by?: string | null
          created_at?: string | null
          description?: string | null
          github_link?: string | null
          handoff_notes?: string | null
          id?: string | null
          priority?: number | null
          scenario?: string | null
          status?: string | null
          task_hash?: string | null
          title?: string | null
          version?: number | null
        }
        Update: {
          claimed_by?: string | null
          created_at?: string | null
          description?: string | null
          github_link?: string | null
          handoff_notes?: string | null
          id?: string | null
          priority?: number | null
          scenario?: string | null
          status?: string | null
          task_hash?: string | null
          title?: string | null
          version?: number | null
        }
        Relationships: []
      }
      v_grok_inbox: {
        Row: {
          content_preview: string | null
          created_at: string | null
          from_ai: string | null
          id: number | null
          priority: number | null
          requires_response: boolean | null
          subject: string | null
        }
        Insert: {
          content_preview?: never
          created_at?: string | null
          from_ai?: string | null
          id?: number | null
          priority?: number | null
          requires_response?: boolean | null
          subject?: string | null
        }
        Update: {
          content_preview?: never
          created_at?: string | null
          from_ai?: string | null
          id?: number | null
          priority?: number | null
          requires_response?: boolean | null
          subject?: string | null
        }
        Relationships: []
      }
      v_provider_daily_usage: {
        Row: {
          day: string | null
          free_tasks: number | null
          paid_tasks: number | null
          provider: string | null
          tasks: number | null
        }
        Relationships: []
      }
      v_public_mcp_registry: {
        Row: {
          description: string | null
          keywords: string[] | null
          name: string | null
          product: string | null
          task_types: string[] | null
        }
        Insert: {
          description?: string | null
          keywords?: string[] | null
          name?: string | null
          product?: string | null
          task_types?: string[] | null
        }
        Update: {
          description?: string | null
          keywords?: string[] | null
          name?: string | null
          product?: string | null
          task_types?: string[] | null
        }
        Relationships: []
      }
      v_sean_action_required: {
        Row: {
          content: string | null
          created_at: string | null
          id: number | null
          message_type: string | null
          posted_by: string | null
        }
        Insert: {
          content?: string | null
          created_at?: string | null
          id?: number | null
          message_type?: string | null
          posted_by?: string | null
        }
        Update: {
          content?: string | null
          created_at?: string | null
          id?: number | null
          message_type?: string | null
          posted_by?: string | null
        }
        Relationships: []
      }
      v_sean_queue: {
        Row: {
          assigned_to: string | null
          created_at: string | null
          description: string | null
          id: number | null
          title: string | null
        }
        Insert: {
          assigned_to?: string | null
          created_at?: string | null
          description?: string | null
          id?: number | null
          title?: string | null
        }
        Update: {
          assigned_to?: string | null
          created_at?: string | null
          description?: string | null
          id?: number | null
          title?: string | null
        }
        Relationships: []
      }
      v_shofet_pending_rulings: {
        Row: {
          confirmed_at: string | null
          confirmed_by: string | null
          created_at: string | null
          evidence: Json | null
          executed_at: string | null
          id: number | null
          outcome: string | null
          requires_confirmation: boolean | null
          ruling_reason: string | null
          ruling_type: string | null
          shofet_repid_at_ruling: number | null
          target_agent: string | null
          target_task_id: number | null
          task_current_status: string | null
          task_title: string | null
        }
        Relationships: [
          {
            foreignKeyName: "trinity_shofet_rulings_target_task_id_fkey"
            columns: ["target_task_id"]
            isOneToOne: false
            referencedRelation: "trinity_post_task_lag"
            referencedColumns: ["task_id"]
          },
          {
            foreignKeyName: "trinity_shofet_rulings_target_task_id_fkey"
            columns: ["target_task_id"]
            isOneToOne: false
            referencedRelation: "trinity_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      v_team_feed: {
        Row: {
          content: string | null
          flag: string | null
          message_type: string | null
          posted_by: string | null
          time: string | null
        }
        Relationships: []
      }
      v_user_points: {
        Row: {
          convertible_points: number | null
          email: string | null
          first_activity: string | null
          last_activity: string | null
          nickname: string | null
          total_activities: number | null
          total_points: number | null
          trustrails_points: number | null
          trustshell_points: number | null
          trusttrader_points: number | null
        }
        Relationships: []
      }
      view_agent_performance: {
        Row: {
          agent_name: string | null
          attempts: number | null
          avg_score: number | null
          benchmark_type: string | null
          last_attempt: string | null
        }
        Relationships: []
      }
      x402_settlement_dashboard: {
        Row: {
          circuit_breaker_state: string | null
          dashboard_window_start: string | null
          failures_1h: number | null
          last_real_settlement_at: string | null
          max_usdc_per_agent_hour: string | null
          real_settlements_1h: number | null
          real_settlements_24h: number | null
          simulated_settlements_1h: number | null
          total_usdc_micros_1h: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      acknowledge_broadcast: {
        Args: { p_broadcast_id: number; p_conductor_id: string }
        Returns: boolean
      }
      ai_onboarding: {
        Args: never
        Returns: {
          data: Json
          section: string
        }[]
      }
      anfis_provider_performance_lookup: {
        Args: { p_domain: string; p_window_days: number }
        Returns: {
          avg_cost_usdc: number
          avg_latency_ms: number
          hit_rate: number
          provider: string
          sample_count: number
        }[]
      }
      append_hal_audit_chain: {
        Args: {
          p_canonical_json_text: string
          p_event_payload: Json
          p_source_id: string
          p_source_table: string
        }
        Returns: {
          current_entry_hash: string
          id: number
        }[]
      }
      apply_linked_bet_resolution: {
        Args: {
          p_bet_id: string
          p_oracle_outcome: boolean
          p_oracle_signature: string
          p_repid_delta: number
          p_token_delta: number
        }
        Returns: Json
      }
      apply_repid_decay: { Args: never; Returns: undefined }
      archive_stale_cold: { Args: never; Returns: number }
      ats_status_report: {
        Args: never
        Returns: {
          component: string
          last_verified: string
          notes: string
          platform: string
          status: string
          type: string
        }[]
      }
      award_hyperdag_points: {
        Args: {
          p_activity_type: string
          p_ecosystem_source?: string
          p_email: string
          p_metadata?: Json
          p_nickname?: string
          p_vertical?: string
        }
        Returns: Json
      }
      broadcast_to_agents: {
        Args: {
          p_content: Json
          p_expires_hours?: number
          p_priority?: number
          p_requires_ack?: boolean
          p_scope?: string
          p_source_id: string
          p_source_type: string
          p_target_conductors?: string[]
          p_title: string
          p_type: string
        }
        Returns: number
      }
      calculate_collusion_risk: {
        Args: {
          p_agent_id: string
          p_challenged_id: string
          p_window_days?: number
        }
        Returns: number
      }
      calculate_task_value: { Args: { p_task_id: number }; Returns: number }
      chaos_monkey: { Args: { p_intensity?: string }; Returns: string }
      check_auto_tune_triggers: {
        Args: never
        Returns: {
          reason: string
          should_tune: boolean
          suggested_change: string
        }[]
      }
      check_circuit_breaker: {
        Args: { p_circuit_id: string }
        Returns: boolean
      }
      check_conductor_productivity: {
        Args: { p_conductor_id: string; p_window_hours?: number }
        Returns: {
          external_rate: number
          is_allowed: boolean
          reason: string
          recommendation: string
          research_rate: number
        }[]
      }
      check_mission_alignment: {
        Args: { proposed_action: string }
        Returns: {
          aligned: boolean
          mission: string
          reasoning: string
        }[]
      }
      check_spawn_explosion: {
        Args: never
        Returns: {
          alert: string
          spawned_count: number
          task_id: number
          title: string
        }[]
      }
      circuit_breaker_failure: {
        Args: { p_circuit_id: string }
        Returns: undefined
      }
      circuit_breaker_success: {
        Args: { p_circuit_id: string }
        Returns: undefined
      }
      claim_next_task: {
        Args: { p_conductor_id: string }
        Returns: {
          actual_cost: number | null
          agent_assigned: string | null
          agent_name: string | null
          artifact_url: string | null
          assigned_to: string | null
          belief: number | null
          blocks_tags: string[] | null
          can_parallel: boolean | null
          certainty: number | null
          claimed_at: string | null
          claimed_by: string | null
          completed_at: string | null
          completed_by: string | null
          consensus_group: string | null
          created_at: string | null
          dependencies: string[] | null
          dependency_tags: string[] | null
          description: string
          disbelief: number | null
          escalated_at: string | null
          escalated_to: string | null
          escalation_level: number | null
          estimated_cost: number | null
          estimated_minutes: number | null
          expected_output: string | null
          expires_at: string | null
          external_artifact_url: string | null
          failure_reflection: string | null
          feature_tag: string | null
          final_verdict: string | null
          generation: number | null
          github_issue_number: number | null
          github_issue_url: string | null
          id: number
          insert_source: string | null
          is_evergreen: boolean | null
          is_real: boolean | null
          last_spawned_at: string | null
          max_duration_minutes: number | null
          metadata: Json | null
          needs_peer: boolean | null
          parent_task_id: number | null
          pipeline_stage: number | null
          priority: number | null
          progress_percent: number | null
          project_id: string | null
          proof_of_work: string | null
          reasoning_depth: number | null
          recurring_minutes: number | null
          reflected: boolean | null
          rep_id_stake: number | null
          repid_score: number | null
          repid_verified: boolean | null
          requires_consensus: boolean | null
          requires_external_artifact: boolean | null
          result: string | null
          score: number | null
          self_certainty: number | null
          signatures: Json | null
          spawned_count: number | null
          sprint_tag: string | null
          started_at: string | null
          status: string | null
          stuck_reason: string | null
          success_criteria: string | null
          tags: string[] | null
          task_category: string | null
          task_type: string | null
          tiebreaker_agent_id: string | null
          tiebreaker_evidence: string | null
          tiebreaker_verdict: string | null
          tiebroken_at: string | null
          tier: number | null
          title: string | null
          uncertainty: number | null
          updated_at: string | null
          use_acp: boolean | null
          v1_stub: boolean | null
          value_score: number | null
          verification_details: Json | null
          verification_method: string | null
          verification_proof: string | null
          verification_required: boolean | null
          verification_result: string | null
          verification_triad: string | null
          verified_at: string | null
          verified_by: string[] | null
          verified_output: Json | null
          verifier_agent_id: string | null
          verifier_evidence: string | null
          verifier_verdict: string | null
          verify_count: number | null
          workspace_id: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "trinity_tasks"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      complete_antigravity_prompt: {
        Args: {
          p_artifacts?: string[]
          p_failure_reason?: string
          p_learnings?: string
          p_prompt_id: number
          p_result_summary: string
          p_success: boolean
        }
        Returns: boolean
      }
      complete_sync: {
        Args: {
          p_error?: string
          p_queue_id: number
          p_records_processed?: number
          p_success: boolean
        }
        Returns: undefined
      }
      compute_tier:
        | { Args: { p_agent_id: string; p_repid: number }; Returns: string }
        | { Args: { repid: number }; Returns: string }
      compute_unified_repid: {
        Args: {
          p_earned: number
          p_earned_weight?: number
          p_perceived: number
          p_perceived_weight?: number
        }
        Returns: number
      }
      conductor_tune: {
        Args: { conductor_name: string; new_value: number; param_key: string }
        Returns: string
      }
      convert_dbt_to_sbt: {
        Args: { p_dbt_id: string; p_institution: string; p_wallet: string }
        Returns: string
      }
      count_unique_counterparties: {
        Args: { p_agent_id: string }
        Returns: number
      }
      create_trust_event: {
        Args: {
          p_actor: string
          p_details: Json
          p_institution: string
          p_type: string
        }
        Returns: string
      }
      daily_system_health_check: {
        Args: never
        Returns: {
          action_required: boolean
          check_name: string
          check_status: string
          detail: string
        }[]
      }
      demote_stale_warm: { Args: never; Returns: number }
      exec_sql: { Args: { query: string }; Returns: Json }
      explain_decision: { Args: { decision: string }; Returns: string }
      get_active_master_plan: { Args: never; Returns: Json }
      get_best_provider: {
        Args: { p_task_type?: string }
        Returns: {
          cost_per_1k: number
          model: string
          provider_name: string
          reason: string
        }[]
      }
      get_conductor_permissions: {
        Args: { p_conductor_id: string }
        Returns: {
          can_issue_directives: boolean
          can_modify_config: boolean
          can_propose_changes: boolean
          can_spawn_subtasks: boolean
          can_vote: boolean
          max_concurrent_tasks: number
          max_entropy_budget: number
          max_subtask_depth: number
          permissions: Json
          tier_name: string
          voting_weight: number
        }[]
      }
      get_execution_stats: {
        Args: { p_date?: string }
        Returns: {
          free_tier_rate: number
          top_agent: string
          top_provider: string
          total_calls: number
          total_cost: number
          total_savings: number
        }[]
      }
      get_next_antigravity_prompt: {
        Args: never
        Returns: {
          created_at: string
          created_by: string
          estimated_minutes: number
          id: number
          priority: number
          prompt_body: string
          prompt_title: string
        }[]
      }
      get_next_sync: {
        Args: never
        Returns: {
          attempts: number
          id: number
          payload: Json
          sync_type: string
        }[]
      }
      get_pending_broadcasts: {
        Args: { p_conductor_id: string }
        Returns: {
          broadcast_type: string
          content: Json
          created_at: string
          id: number
          priority: number
          requires_acknowledgment: boolean
          title: string
        }[]
      }
      get_pending_updates: {
        Args: { p_agent_id: string }
        Returns: {
          created_at: string
          id: number
          payload: Json
          update_type: string
        }[]
      }
      get_repid_config: { Args: { config_key: string }; Returns: number }
      get_scaled_reward: { Args: never; Returns: number }
      get_user_ai_name: { Args: { user_uuid: string }; Returns: string }
      get_user_latest_ai_personality: {
        Args: { user_uuid: string }
        Returns: string
      }
      get_user_tier: { Args: { repid: number }; Returns: string }
      get_validation_queue_status_24h: {
        Args: never
        Returns: {
          avgAgeSeconds: number
          completed: number
          escalated: number
          failed: number
          oldestPendingAgeSeconds: number
          pending: number
          processing: number
        }[]
      }
      graph_rag_match_nodes: {
        Args: {
          p_agent_id: string
          p_match_count?: number
          p_node_types?: string[]
          p_query_embedding: string
          p_similarity_threshold?: number
        }
        Returns: {
          access_count: number
          accessed_at: string
          agent_id: string
          content: string
          created_at: string
          id: string
          importance: number
          metadata: Json
          node_type: string
          similarity: number
          source_event_id: number
        }[]
      }
      graph_rag_touch_node: { Args: { p_node_id: string }; Returns: undefined }
      increment_provider_spend: {
        Args: { amount: number; p_name: string }
        Returns: undefined
      }
      log_agent_execution: {
        Args: {
          p_agent_name: string
          p_duration_seconds?: number
          p_hours_saved?: number
          p_output_preview?: string
          p_success: boolean
          p_task_name: string
        }
        Returns: number
      }
      log_bug_encounter: {
        Args: { p_bug_code: string; p_error_message?: string }
        Returns: string
      }
      log_execution: {
        Args: {
          p_agent: string
          p_error?: string
          p_latency_ms?: number
          p_model?: string
          p_provider: string
          p_success?: boolean
          p_task_id?: number
          p_task_type?: string
          p_tokens?: number
        }
        Returns: number
      }
      log_health_check: {
        Args: {
          p_agent: string
          p_details?: Json
          p_errors?: number
          p_status: string
          p_trigger_healing?: boolean
        }
        Returns: string
      }
      log_repid_event:
        | {
            Args: {
              p_event_data?: string
              p_event_type: string
              p_reputation_delta?: number
              p_subject_id?: string
              p_subject_type?: string
            }
            Returns: undefined
          }
        | {
            Args: {
              p_event_data: Json
              p_event_type: string
              p_parent_event_id?: number
              p_reputation_delta: number
              p_subject_id: string
              p_subject_type: string
            }
            Returns: number
          }
        | {
            Args: {
              p_event_data?: string
              p_event_type: string
              p_reputation_delta?: number
              p_subject_id: string
              p_subject_type: string
            }
            Returns: undefined
          }
      match_learned_patterns: {
        Args: {
          match_count?: number
          match_threshold?: number
          query_embedding: string
        }
        Returns: {
          confidence: number
          id: number
          learned_insight: string
          pattern_type: string
          similarity: number
        }[]
      }
      match_nodes: {
        Args: {
          match_count: number
          match_threshold: number
          query_embedding: string
        }
        Returns: {
          agent_owner: string
          id: string
          node_type: string
          similarity: number
        }[]
      }
      match_nodes_keyword: {
        Args: { match_count: number; query_text: string }
        Returns: {
          agent_owner: string
          id: string
          node_type: string
          score: number
        }[]
      }
      match_semantic_cache: {
        Args: {
          match_count: number
          match_threshold: number
          query_embedding: string
        }
        Returns: {
          id: string
          provider_used: string
          query_text: string
          response_text: string
          similarity: number
        }[]
      }
      maybe_spawn_harder_variant: {
        Args: {
          p_completion_minutes: number
          p_expected_minutes?: number
          p_task_id: number
        }
        Returns: number
      }
      normalize_agent_name: { Args: { raw_name: string }; Returns: string }
      process_prediction_postmortem: {
        Args: {
          p_asset: string
          p_composite_score: number
          p_correct_1h: boolean
          p_correct_24h: boolean
          p_correct_4h: boolean
          p_cycle_id: string
          p_operator_id?: string
        }
        Returns: undefined
      }
      process_vote_aggregates: { Args: never; Returns: number }
      promote_to_warm: {
        Args: {
          p_agent: string
          p_brain_region?: string
          p_content: string
          p_embedding: string
          p_user_id: string
        }
        Returns: number
      }
      propose_config_change: {
        Args: {
          is_auto?: boolean
          new_value: number
          param_key: string
          proposer: string
          reason?: string
        }
        Returns: string
      }
      queue_ai_model_sync: { Args: { p_agent: string }; Returns: number }
      queue_antigravity_prompt: {
        Args: {
          p_agent: string
          p_body: string
          p_estimated_minutes?: number
          p_priority?: number
          p_source_task_id?: number
          p_title: string
        }
        Returns: number
      }
      queue_debate_sync: {
        Args: {
          p_agent: string
          p_ai_a_id: string
          p_ai_a_name: string
          p_ai_a_position: string
          p_ai_b_id: string
          p_ai_b_name: string
          p_ai_b_position: string
          p_duration_minutes?: number
          p_topic: string
        }
        Returns: number
      }
      recall_memory: {
        Args: {
          p_agent_filter?: string
          p_limit?: number
          p_query_embedding: string
          p_user_id: string
          p_user_tier?: string
        }
        Returns: {
          agent_name: string
          brain_region: string
          content: string
          memory_id: number
          similarity: number
          tier: string
        }[]
      }
      record_failure: {
        Args: {
          p_agent: string
          p_failure_message: string
          p_failure_type: string
          p_root_cause?: string
          p_task_id: number
        }
        Returns: number
      }
      refresh_system_truth: { Args: never; Returns: undefined }
      request_healing_help: {
        Args: {
          p_bug_code: string
          p_context?: Json
          p_request_type?: string
          p_requesting_agent: string
          p_target_agent?: string
        }
        Returns: string
      }
      requires_peer_verification: {
        Args: { agent_tier: string; is_real: boolean; self_certainty: number }
        Returns: boolean
      }
      resurrect_stale_tasks: {
        Args: { p_stale_hours?: number }
        Returns: number
      }
      run_sql: { Args: { sql: string }; Returns: Json }
      share_learning: {
        Args: {
          p_applicability?: Json
          p_conductor_id: string
          p_description: string
          p_evidence: Json
          p_title: string
          p_type: string
        }
        Returns: number
      }
      shofet_propose_ruling: {
        Args: {
          p_agent: string
          p_evidence: Json
          p_reason: string
          p_task_id: number
          p_type: string
        }
        Returns: number
      }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
      spawn_evergreen_tasks: { Args: never; Returns: number }
      spot_audit_probability: { Args: { agent_tier: string }; Returns: number }
      start_antigravity_prompt: {
        Args: { p_prompt_id: number }
        Returns: boolean
      }
      start_sync: { Args: { p_queue_id: number }; Returns: boolean }
      touch_memory: {
        Args: { p_id: number; p_tier: string }
        Returns: undefined
      }
      trinity_approve_action: {
        Args: { action_id: number; approver: string; notes?: string }
        Returns: Json
      }
      trinity_detect_stale: {
        Args: { threshold_minutes?: number }
        Returns: {
          agent: string
          minutes_stale: number
        }[]
      }
      trinity_pending_wisdom: {
        Args: never
        Returns: {
          agent: string
          created_at: string
          id: number
          proposed_amendment: string
          virtue_alignment: string
        }[]
      }
      trinity_reject_action: {
        Args: { action_id: number; reason: string; rejector: string }
        Returns: Json
      }
      trinity_swarm_health: {
        Args: never
        Returns: {
          agent: string
          is_healthy: boolean
          last_seen: string
          minutes_ago: number
          status: string
          version: string
        }[]
      }
      unlock_next_blueprint: {
        Args: { verified_codename: string; verifier: string }
        Returns: string
      }
      update_agent_domain_accuracy: {
        Args: { p_agent_id: string; p_domain: string; p_was_correct: boolean }
        Returns: undefined
      }
      update_routing_weight: {
        Args: { p_latency_ms?: number; p_provider: string; p_success: boolean }
        Returns: undefined
      }
      vote_config_change: {
        Args: { proposal_id: string; vote_for: boolean; voter: string }
        Returns: string
      }
    }
    Enums: {
      [_ in never]: never
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
    Enums: {},
  },
} as const


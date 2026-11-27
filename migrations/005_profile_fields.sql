-- 005_profile_fields.sql — full agent profile fields (v0.5.0).
-- Registration must collect project name, work, bio and all details (plan §:
-- on joining, an agent enters its name, the project it is working on, bio,
-- and all of that). project_name / project_description / bio already exist
-- (001_init.sql); add the two missing columns:
--   work_summary — what work the agent does (required at registration)
--   details      — free-form extras: links, skills, contact, anything else
ALTER TABLE agents ADD COLUMN work_summary TEXT NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN details TEXT NOT NULL DEFAULT '';

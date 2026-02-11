// ─── Ashby API response wrappers ────────────────────────────────────────────

export interface AshbySuccessResponse<T> {
  success: true;
  results: T;
}

export interface AshbyPaginatedResponse<T> {
  success: true;
  results: T[];
  moreDataAvailable: boolean;
  nextCursor?: string;
}

export interface AshbyErrorResponse {
  success: false;
  errors?: string[];
  errorInfo?: {
    code: string;
    message?: string;
    requestId?: string;
  };
}

export type AshbyResponse<T> = AshbySuccessResponse<T> | AshbyErrorResponse;
export type AshbyListResponse<T> =
  | AshbyPaginatedResponse<T>
  | AshbyErrorResponse;

// ─── Common nested types ────────────────────────────────────────────────────

export interface ContactInfo {
  value: string;
  type: string;
  isPrimary: boolean;
}

export interface CustomField {
  id: string;
  isPrivate: boolean;
  title: string;
  value: unknown;
  valueLabel?: string | string[];
}

export interface HiringTeamMember {
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
}

export interface SourceInfo {
  id: string;
  title: string;
  isArchived: boolean;
}

export interface InterviewStageRef {
  id: string;
  title: string;
  type: string;
  orderInInterviewPlan: number;
  interviewPlanId?: string;
}

export interface JobRef {
  id: string;
  title: string;
  locationId?: string;
  departmentId?: string;
}

export interface CandidateRef {
  id: string;
  name: string;
  primaryEmailAddress?: ContactInfo;
  primaryPhoneNumber?: ContactInfo;
}

export interface TagRef {
  id: string;
  title: string;
  isArchived: boolean;
}

export interface FileHandle {
  id: string;
  name: string;
  handle: string;
}

// ─── Job ────────────────────────────────────────────────────────────────────

export interface Job {
  id: string;
  title: string;
  status: string;
  employmentType?: string;
  confidential?: boolean;
  locationId?: string;
  departmentId?: string;
  defaultInterviewPlanId?: string;
  interviewPlanIds?: string[];
  jobPostingIds?: string[];
  customFields?: CustomField[];
  hiringTeam?: HiringTeamMember[];
  createdAt: string;
  updatedAt: string;
  openedAt?: string;
  closedAt?: string;
}

// ─── Archive reason ─────────────────────────────────────────────────────────

export interface ArchiveReason {
  id: string;
  text: string;
  reasonType: string;
  isArchived: boolean;
}

// ─── Communication template ─────────────────────────────────────────────────

export interface CommunicationTemplate {
  id: string;
  name: string;
  [key: string]: unknown;
}

// ─── Interview stage ────────────────────────────────────────────────────────

export interface InterviewStage {
  id: string;
  title: string;
  type: string;
  orderInInterviewPlan: number;
  interviewStageGroupId?: string;
}

// ─── Interview plan ─────────────────────────────────────────────────────────

export interface InterviewPlan {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Application ────────────────────────────────────────────────────────────

export interface Application {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: "Hired" | "Archived" | "Active" | "Lead";
  candidate: CandidateRef;
  currentInterviewStage?: InterviewStageRef;
  job: JobRef;
  source?: SourceInfo;
  archiveReason?: { id: string; text: string; reasonType: string };
  hiringTeam?: HiringTeamMember[];
  customFields?: CustomField[];
  resumeFileHandle?: FileHandle;
  applicationHistory?: ApplicationHistoryEntry[];
}

// ─── Application history entry ──────────────────────────────────────────────

export interface ApplicationHistoryEntry {
  id: string;
  stageId: string;
  title: string;
  enteredStageAt: string;
  leftStageAt?: string;
  stageNumber: number;
}

// ─── Criteria evaluation ────────────────────────────────────────────────────

export interface CriteriaEvaluation {
  [key: string]: unknown;
}

// ─── Feedback ───────────────────────────────────────────────────────────────

export interface ApplicationFeedback {
  [key: string]: unknown;
}

// ─── Candidate ──────────────────────────────────────────────────────────────

export interface Candidate {
  id: string;
  name: string;
  primaryEmailAddress?: ContactInfo;
  primaryPhoneNumber?: ContactInfo;
  emailAddresses?: ContactInfo[];
  phoneNumbers?: ContactInfo[];
  socialLinks?: { type: string; url: string }[];
  tags?: TagRef[];
  source?: SourceInfo;
  customFields?: CustomField[];
  applicationIds?: string[];
  fileHandles?: FileHandle[];
  profileUrl?: string;
}

// ─── Note ───────────────────────────────────────────────────────────────────

export interface CandidateNote {
  id: string;
  createdAt: string;
  isPrivate: boolean;
  content: string;
  author?: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  };
}

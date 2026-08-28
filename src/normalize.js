const isCollection = (e) =>
  e?.$type === "com.linkedin.restli.common.CollectionResponse";

function buildIndex(raw) {
  const index = new Map();
  for (const entity of raw?.included ?? []) {
    if (entity?.entityUrn) index.set(entity.entityUrn, entity);
  }
  return index;
}

/** Follow a URN pointer. Collections are flattened to the entities they hold. */
function deref(index, urn) {
  if (!urn) return null;
  const entity = index.get(urn);
  if (!entity) return null;
  if (isCollection(entity)) {
    return (entity["*elements"] ?? []).map((u) => index.get(u)).filter(Boolean);
  }
  return entity;
}

const derefList = (index, urn) => {
  const result = deref(index, urn);
  return Array.isArray(result) ? result : result ? [result] : [];
};

/**
 * LinkedIn images are `rootUrl` + one of several `artifacts` path segments.
 * Take the widest artifact; the URLs are signed and expire (~30 days), so a
 * frontend that caches them should re-fetch rather than store them forever.
 */
function imageUrl(container) {
  const vector =
    container?.vectorImage ?? container?.displayImageReference?.vectorImage;
  if (!vector?.rootUrl || !vector.artifacts?.length) return null;
  const widest = vector.artifacts.reduce((a, b) =>
    (b.width ?? 0) > (a.width ?? 0) ? b : a,
  );
  return widest.fileIdentifyingUrlPathSegment
    ? vector.rootUrl + widest.fileIdentifyingUrlPathSegment
    : null;
}

/** {year, month, day} -> "2023-07" / "2023" / null. Months are 1-indexed. */
function formatDate(date) {
  if (!date?.year) return null;
  if (!date.month) return String(date.year);
  const month = String(date.month).padStart(2, "0");
  return date.day
    ? `${date.year}-${month}-${String(date.day).padStart(2, "0")}`
    : `${date.year}-${month}`;
}

function dateRange(range) {
  const start = formatDate(range?.start);
  const end = formatDate(range?.end);
  return { start, end, current: Boolean(start) && !end };
}

/** URNs look like urn:li:fsd_company:2340783 — the tail is the usable id. */
const urnId = (urn) =>
  typeof urn === "string" ? (urn.split(":").pop() ?? null) : null;

function mapCompany(index, entity) {
  const company = deref(index, entity["*company"]);
  if (!company)
    return { name: entity.companyName ?? entity.schoolName ?? null };
  return {
    name: company.name ?? entity.companyName ?? entity.schoolName ?? null,
    id: urnId(company.entityUrn),
    url:
      company.url ??
      (company.entityUrn
        ? `https://www.linkedin.com/company/${urnId(company.entityUrn)}/`
        : null),
    logoUrl: imageUrl(company.logo),
  };
}

function mapPositions(index, profile) {
  const groups = derefList(index, profile["*profilePositionGroups"]);
  const positions = groups.flatMap((group) =>
    derefList(index, group["*profilePositionInPositionGroup"]),
  );

  return positions
    .map((position) => ({
      title: position.title ?? null,
      company: mapCompany(index, position),
      employmentType: deref(index, position["*employmentType"])?.name ?? null,
      location: position.locationName ?? null,
      description: position.description ?? null,
      ...dateRange(position.dateRange),
    }))
    .sort(byStartDateDesc);
}

function mapEducation(index, profile) {
  return derefList(index, profile["*profileEducations"])
    .map((education) => ({
      school: education.schoolName ?? null,
      schoolId: urnId(education.schoolUrn),
      schoolUrl: deref(index, education["*company"])?.url ?? null,
      logoUrl: imageUrl(deref(index, education["*company"])?.logo),
      degree: education.degreeName ?? null,
      fieldOfStudy: education.fieldOfStudy ?? null,
      grade: education.grade ?? null,
      description: education.description ?? null,
      ...dateRange(education.dateRange),
    }))
    .sort(byStartDateDesc);
}

function mapCertifications(index, profile) {
  return derefList(index, profile["*profileCertifications"])
    .map((certification) => ({
      name: certification.name ?? null,
      authority: certification.authority ?? null,
      licenseNumber: certification.licenseNumber ?? null,
      url: certification.url ?? null,
      issuedOn: formatDate(certification.dateRange?.start),
      expiresOn: formatDate(certification.dateRange?.end),
    }))
    .sort((a, b) =>
      String(b.issuedOn ?? "").localeCompare(String(a.issuedOn ?? "")),
    );
}

const byStartDateDesc = (a, b) =>
  String(b.start ?? "").localeCompare(String(a.start ?? ""));

export function normalizeProfile(raw) {
  const index = buildIndex(raw);

  const rootUrn = raw?.data?.["*elements"]?.[0];
  const profile =
    (rootUrn && index.get(rootUrn)) ||
    (raw?.included ?? []).find(
      (e) => e.$type === "com.linkedin.voyager.dash.identity.profile.Profile",
    );

  if (!profile) return null;

  const firstName = profile.firstName ?? null;
  const lastName = profile.lastName ?? null;

  return {
    profileId: urnId(profile.entityUrn),
    memberId: urnId(profile.objectUrn),
    publicId: profile.publicIdentifier ?? null,
    profileUrl: profile.publicIdentifier
      ? `https://www.linkedin.com/in/${profile.publicIdentifier}/`
      : null,

    firstName,
    lastName,
    fullName: [firstName, lastName].filter(Boolean).join(" ") || null,
    headline: profile.headline ?? null,
    summary: profile.summary ?? null,
    pronoun: profile.pronounUnion?.standardizedPronoun ?? null,

    location:
      deref(index, profile.geoLocation?.["*geo"])?.defaultLocalizedName ?? null,
    countryCode: profile.location?.countryCode ?? null,
    industry: deref(index, profile["*industry"])?.name ?? null,

    photoUrl: imageUrl(profile.profilePicture),
    backgroundUrl: imageUrl(profile.backgroundPicture),

    isPremium: profile.premium ?? false,
    isInfluencer: profile.influencer ?? false,
    isCreator: profile.creator ?? false,

    positions: mapPositions(index, profile),
    education: mapEducation(index, profile),
    skills: derefList(index, profile["*profileSkills"])
      .map((skill) => skill.name)
      .filter(Boolean),
    certifications: mapCertifications(index, profile),
  };
}

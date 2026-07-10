export function extractNumbers(text: string): number[] {
  const regex = /\b\d{1,3}(?:,\d{3})*(?:\.\d+)?\b|\b\d+\b/g;
  const matches = text.match(regex);
  if (!matches) return [];
  return matches.map(m => parseInt(m.replace(/,/g, ''), 10)).filter(n => !isNaN(n));
}

export interface FilterState {
  location?: string;
  budget?: number | null;
  propertyTypes?: string[];
  preferredTenants?: string[];
  requirements?: string[];
  postedBy?: string[];
  globalQuery?: string; // Keep this just in case, but we parse it out
}

export function normalizePost(text: string): string {
  if (!text) return "";
  return text.toLowerCase().trim();
}

// The exact logic from the Sidebar filters (search.astro)
export function matchesPost(postObj: any, filters: FilterState, strictLocation: boolean = true): boolean {
  if (!postObj) return false;
  
  // Combine all text for regular filtering
  let body = [postObj.body, postObj.author, postObj.group_name, postObj.location, postObj.property_type, postObj.preferred_tenant, postObj.requirement, postObj.post_type].filter(Boolean).join(" ").toLowerCase();

  // --- 1. Location Filter ---
  const locQuery = filters.location ? filters.location.toLowerCase().trim() : "";
  const matchesLocation = !strictLocation || !locQuery || body.includes(locQuery);

  // --- 2. Budget Filter ---
  let matchesBudget = true;
  const budgetValue = filters.budget;
  if (budgetValue !== undefined && budgetValue !== null && budgetValue > 0) {
    const numbersInPost = extractNumbers(body);
    // Assume valid rent/price numbers are at least 1000 (to filter out 2bhk, floor 3, etc)
    const rentNumbers = numbersInPost.filter(n => n >= 1000);
    if (rentNumbers.length > 0) {
      matchesBudget = rentNumbers.some(n => n <= budgetValue);
    } else {
      // If no numbers > 1000 found, exclude if they strictly want a budget limit.
      matchesBudget = false;
    }
  }

  // --- 3. Property Type Filter ---
  let matchesType = true;
  const selectedTypes = filters.propertyTypes || [];
  if (selectedTypes.length > 0) {
    matchesType = selectedTypes.some(type => {
      if (type === '1bhk') return body.includes('1bhk') || body.includes('1 bhk');
      if (type === '2bhk') return body.includes('2bhk') || body.includes('2 bhk');
      if (type === '3bhk') return body.includes('3bhk') || body.includes('3 bhk');
      if (type === '4bhk') return body.includes('4bhk') || body.includes('4 bhk');
      if (type === 'boyspg') return body.includes('boy pg') || body.includes('boys pg') || body.includes('boyspg') || body.includes('boy\'s pg');
      if (type === 'girlspg') return body.includes('girl pg') || body.includes('girls pg') || body.includes('girlspg') || body.includes('girl\'s pg');
      return false;
    });
  }

  // --- 4. Tenant Filter ---
  let matchesTenant = true;
  const selectedTenants = filters.preferredTenants || [];
  if (selectedTenants.length > 0) {
    matchesTenant = selectedTenants.some(tenant => {
      if (tenant === 'bacelor' || tenant === 'bachelors') return body.includes('bacelor') || body.includes('bachelor');
      if (tenant === 'families' || tenant === 'family') return body.includes('families') || body.includes('family');
      return false;
    });
  }

  // --- 5. Requirement Filter ---
  let matchesRequirement = true;
  const selectedRequirements = filters.requirements || [];
  if (selectedRequirements.length > 0) {
    matchesRequirement = selectedRequirements.some(req => {
      if (req === 'flat') return body.includes('looking for flat') || body.includes('looking for flate') || body.includes('need a flat') || body.includes('need flat') || body.includes('available for rent') || body.includes('rent') || body.includes('to let') || body.includes('flat available') || body.includes('flate available');
      if (req === 'flatmate') return body.includes('looking for flatmate') || body.includes('looking for flatemate') || body.includes('looking for flatement') || body.includes('looking for flatemants') || body.includes('need flatmate') || body.includes('flatmate required') || body.includes('roommate') || body.includes('room partner') || body.includes('pg') || body.includes('sharing');
      return false;
    });
  }

  // --- 6. Posted By Filter ---
  let matchesPostedBy = true;
  const selectedPostedBy = filters.postedBy || [];
  if (selectedPostedBy.length > 0) {
    // High confidence keywords for Owner vs Broker
    const hasOwnerKeyword = body.match(/\b(no\s*brokerage|zero\s*brokerage|direct\s*owner|by\s*owner|i\s*am\s*owner)\b/i);
    // Explicitly exclude "no brokerage" from triggering the broker keyword
    const bodyWithoutNoBrokerage = body.replace(/\b(no\s*brokerage|zero\s*brokerage)\b/ig, '');
    const hasBrokerKeyword = bodyWithoutNoBrokerage.match(/\b(brokerage|broker|consulting\s*fee|consultancy|agent|real\s*estate|15\s*days\s*rent|one\s*month\s*rent)\b/i);

    const storedOwnerType = postObj.owner_type ? postObj.owner_type.toLowerCase() : null;

    matchesPostedBy = selectedPostedBy.some(pb => {
      if (pb === 'owner') return (storedOwnerType === 'owner' || (hasOwnerKeyword && !hasBrokerKeyword));
      if (pb === 'broker') return (storedOwnerType === 'broker' || hasBrokerKeyword);
      return false;
    });
  }

  return matchesLocation && matchesBudget && matchesType && matchesTenant && matchesRequirement && matchesPostedBy;
}

export function filterPosts(posts: any[], filters: FilterState, strictLocation: boolean = true): any[] {
  return posts.filter(post => {
    return matchesPost(post, filters, strictLocation);
  });
}

// Parse natural language query into structured Sidebar filters
export function normalizeQuery(query: string): FilterState {
  if (!query) return {};
  let s = query.toLowerCase();

  const filters: FilterState = {
    propertyTypes: [],
    preferredTenants: [],
    requirements: []
  };

  // Extract budget (e.g. "under 15000", "< 20000", or just "15000")
  const budgetMatch = s.match(/(?:under|below|<)?\s*(\d{4,5})/);
  if (budgetMatch) {
    filters.budget = parseInt(budgetMatch[1], 10);
    s = s.replace(budgetMatch[0], "");
  }

  // Extract property types
  if (s.match(/1\s*bhk/)) { filters.propertyTypes!.push('1bhk'); s = s.replace(/1\s*bhk/, ""); }
  if (s.match(/2\s*bhk/)) { filters.propertyTypes!.push('2bhk'); s = s.replace(/2\s*bhk/, ""); }
  if (s.match(/3\s*bhk/)) { filters.propertyTypes!.push('3bhk'); s = s.replace(/3\s*bhk/, ""); }
  if (s.match(/4\s*bhk/)) { filters.propertyTypes!.push('4bhk'); s = s.replace(/4\s*bhk/, ""); }
  if (s.match(/boy[s]?\s*pg/)) { filters.propertyTypes!.push('boyspg'); s = s.replace(/boy[s]?\s*pg/, ""); }
  if (s.match(/girl[s]?\s*pg/)) { filters.propertyTypes!.push('girlspg'); s = s.replace(/girl[s]?\s*pg/, ""); }

  // Extract tenants
  if (s.match(/bachelor/)) { filters.preferredTenants!.push('bachelors'); s = s.replace(/bachelor[s]?/, ""); }
  if (s.match(/famil/)) { filters.preferredTenants!.push('families'); s = s.replace(/famil(?:y|ies)/, ""); }

  // Extract requirements
  if (s.match(/flatmate|roommate/)) { filters.requirements!.push('flatmate'); s = s.replace(/flatmate|roommate/, ""); }
  else if (s.match(/flat/)) { filters.requirements!.push('flat'); s = s.replace(/flat/, ""); }

  // Remove common stop words to isolate location
  s = s.replace(/\b(?:in|at|near|for|the|a|an|to|of|on|with|and)\b/g, " ");
  s = s.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()[\]'\"|]/g, " ");

  // Whatever is left is considered the location or keyword
  const locationStr = s.trim().replace(/\s{2,}/g, " ");
  if (locationStr) {
    filters.location = locationStr;
  }

  return filters;
}

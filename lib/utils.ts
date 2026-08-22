import { interviewCovers } from "@/constants";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import Fuse from "fuse.js";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const techIconBaseURL =
  "https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons";

const normalizeTechName = (tech: string) => {
  const key = tech.toLowerCase().replace(/\.js$/, "").replace(/\s+/g, "");
  return key;
};

const checkIconExists = async (url: string) => {
  try {
    const response = await fetch(url, { method: "HEAD" });
    return response.ok;
  } catch {
    return false;
  }
};

let cachedDeviconNames: string[] | null = null;

const getDeviconNames = async () => {
  if (cachedDeviconNames) return cachedDeviconNames;

  try {
    const response = await fetch(
      "https://raw.githubusercontent.com/devicons/devicon/master/devicon.json"
    );
    const data: unknown = await response.json();
    cachedDeviconNames = Array.isArray(data)
      ? data
          .map((icon) =>
            icon && typeof icon === "object" && "name" in icon
              ? icon.name
              : undefined
          )
          .filter((name): name is string => typeof name === "string")
      : [];
  } catch (error) {
    console.error("Failed to load devicon.json", error);
    cachedDeviconNames = null;
  }

  return cachedDeviconNames;
};

const fuzzyMatchIconName = async (tech: string): Promise<string> => {
  const deviconNames = await getDeviconNames();

  if (!deviconNames) return "devicon";

  const fuse = new Fuse(deviconNames, {
    includeScore: true,
    threshold: 0.4,
  });

  const result = fuse.search(normalizeTechName(tech));
  return result.length > 0 ? result[0].item : "devicon"; // default fallback
};

export const getTechLogos = async (techArray: string[]) => {
  const results = await Promise.all(
    techArray.map(async (tech) => {
      const fuzzyName = await fuzzyMatchIconName(tech);
      const iconUrl = `${techIconBaseURL}/${fuzzyName}/${fuzzyName}-original.svg`;
      const isValid =
        fuzzyName != "devicon" && (await checkIconExists(iconUrl));
      return {
        tech,
        url: isValid ? iconUrl : "/tech.svg",
      };
    })
  );

  return results;
};

export const getRandomInterviewCover = () => {
  const randomIndex = Math.floor(Math.random() * interviewCovers.length);
  return `/covers${interviewCovers[randomIndex]}`;
};
